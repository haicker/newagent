import * as lancedb from '@lancedb/lancedb';
import { config } from '../config.js';
import OpenAI from 'openai';

export interface ClauseChunk {
  id: string;
  regulation_id: string;
  regulation_code: string;
  regulation_name: string;
  section: string;
  content: string;
  is_mandatory: string; // 'true' | 'false' - stored as string for LanceDB compatibility
  category: string;
  province: string;
}

export interface SearchResult {
  id: string;
  regulation: string;
  section: string;
  content: string;
  isMandatory: boolean;
  category: string;
  province: string;
  score: number; // distance score (lower = more similar)
}

/**
 * 方案原文分块（用于专家对话 RAG）
 */
export interface SchemeChunk {
  id: string;
  report_id: string;
  content: string;
}

export interface SchemeSearchResult {
  id: string;
  report_id: string;
  content: string;
  score: number; // distance score (lower = more similar)
}

const TABLE_NAME = 'clauses';
const SCHEME_TABLE = 'scheme_chunks';

export class VectorStore {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private schemeTable: lancedb.Table | null = null;
  private client: OpenAI;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.embedding.apiKey,
      baseURL: config.embedding.baseURL,
    });
  }

  /**
   * 初始化 LanceDB 连接
   */
  async initialize(): Promise<void> {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._doInit();
    await this.initPromise;
  }

  private async _doInit(): Promise<void> {
    this.db = await lancedb.connect(config.paths.vectorDb);

    // 尝试打开已有表
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(TABLE_NAME)) {
      this.table = await this.db.openTable(TABLE_NAME);
    }
    // 如果表不存在，不创建空表，延迟到首次插入时创建
  }

  /**
   * 确保表已初始化（有数据时才会真正创建表）
   */
  private async ensureTable(): Promise<lancedb.Table> {
    await this.initialize();
    if (!this.table) {
      throw new Error('Vector store not initialized. Insert data first to create the table.');
    }
    return this.table;
  }

  /**
   * 生成文本的 embedding 向量
   */
  async embed(text: string): Promise<number[]> {
    const response = await this.client.embeddings.create({
      model: config.embedding.model,
      input: text,
      dimensions: config.embedding.dimension,
    });
    return response.data[0].embedding;
  }

  /**
   * 批量生成 embedding
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: config.embedding.model,
      input: texts,
      dimensions: config.embedding.dimension,
    });
    return response.data.map(d => d.embedding);
  }

  /**
   * 将文本分块为条款块
   */
  chunkText(
    text: string,
    regulationId: string,
    regulationCode: string,
    regulationName: string,
    category: string,
    province?: string
  ): ClauseChunk[] {
    const chunks: ClauseChunk[] = [];

    // 按"第X条"或"X.X.X"模式分割
    const clausePattern = /(?:^|\n)\s*(第[一二三四五六七八九十百千零〇\d]+条[\s\.、．]|(?:\d+\.){1,3}\d+\s|(?:\d+\.){0,2}\d+[\s\.、．])/g;
    const matches = [...text.matchAll(clausePattern)];

    if (matches.length === 0) {
      // 没有明确的条款分割，按固定长度分块
      return this.chunkBySize(text, regulationId, regulationCode, regulationName, category, province);
    }

    for (let i = 0; i < matches.length; i++) {
      const start = matches[i].index!;
      const end = i + 1 < matches.length ? matches[i + 1].index! : text.length;
      const chunkText = text.substring(start, end).trim();

      if (chunkText.length < 10) continue; // 跳过太短的块

      // 提取条款号
      const sectionMatch = chunkText.match(/^(第[一二三四五六七八九十百千零〇\d]+条[\s\.、．]?|(?:\d+\.){1,3}\d+|(?:\d+\.){0,2}\d+[\s\.、．]?)/);
      const section = sectionMatch ? sectionMatch[1].trim() : `条款${i + 1}`;

      // 判断是否强条
      const isMandatory = this.detectMandatory(chunkText);

      // 如果单条过长，进一步切分
      if (chunkText.length > 500) {
        const subChunks = this.splitLongChunk(chunkText, section);
        for (const sub of subChunks) {
          chunks.push({
            id: `chunk-${regulationId}-${chunks.length}`,
            regulation_id: regulationId,
            regulation_code: regulationCode,
            regulation_name: regulationName,
            section: sub.section,
            content: sub.content,
            is_mandatory: isMandatory ? 'true' : 'false',
            category,
            province: province || '',
          });
        }
      } else {
        chunks.push({
          id: `chunk-${regulationId}-${chunks.length}`,
          regulation_id: regulationId,
          regulation_code: regulationCode,
          regulation_name: regulationName,
          section,
          content: chunkText,
          is_mandatory: isMandatory ? 'true' : 'false',
          category,
          province: province || '',
        });
      }
    }

    return chunks;
  }

  /**
   * 按固定大小分块（无明确条款分割时）
   */
  private chunkBySize(
    text: string,
    regulationId: string,
    regulationCode: string,
    regulationName: string,
    category: string,
    province?: string
  ): ClauseChunk[] {
    const chunks: ClauseChunk[] = [];
    const chunkSize = 400;
    const overlap = 50;

    let offset = 0;
    let index = 0;
    while (offset < text.length) {
      const end = Math.min(offset + chunkSize, text.length);
      const content = text.substring(offset, end).trim();
      if (content.length > 10) {
        chunks.push({
          id: `chunk-${regulationId}-${index}`,
          regulation_id: regulationId,
          regulation_code: regulationCode,
          regulation_name: regulationName,
          section: `分段${index + 1}`,
          content,
          is_mandatory: this.detectMandatory(content) ? 'true' : 'false',
          category,
          province: province || '',
        });
        index++;
      }
      offset += chunkSize - overlap;
    }

    return chunks;
  }

  /**
   * 将长条款按段落切分
   */
  private splitLongChunk(text: string, baseSection: string): Array<{ section: string; content: string }> {
    const result: Array<{ section: string; content: string }> = [];
    const paragraphs = text.split(/\n\s*\n/);

    let current = '';
    let subIndex = 0;
    for (const para of paragraphs) {
      if (current.length + para.length > 500 && current.length > 0) {
        result.push({
          section: `${baseSection}-${subIndex + 1}`,
          content: current.trim(),
        });
        subIndex++;
        current = para;
      } else {
        current += '\n' + para;
      }
    }
    if (current.trim().length > 0) {
      result.push({
        section: `${baseSection}-${subIndex + 1}`,
        content: current.trim(),
      });
    }

    return result;
  }

  /**
   * 检测是否为强制性条文
   */
  private detectMandatory(text: string): boolean {
    const mandatoryKeywords = [
      '必须', '严禁', '不得', '不应', '不应少于', '不应大于',
      '应不小于', '应不大于', '强制性', '强条', '黑体',
      'shall not', 'shall', 'must not', 'must', 'mandatory',
    ];
    const lowerText = text.toLowerCase();
    return mandatoryKeywords.some(kw => lowerText.includes(kw.toLowerCase()));
  }

  /**
   * 将条款块插入向量库
   */
  async insertChunks(chunks: ClauseChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    // 生成 embeddings
    const texts = chunks.map(c => `${c.regulation_code} ${c.section} ${c.content}`);
    const embeddings = await this.embedBatch(texts);

    const records = chunks.map((chunk, i) => ({
      id: chunk.id,
      regulation_id: chunk.regulation_id,
      regulation_code: chunk.regulation_code,
      regulation_name: chunk.regulation_name,
      section: chunk.section,
      content: chunk.content,
      is_mandatory: chunk.is_mandatory,
      category: chunk.category,
      province: chunk.province,
      vector: embeddings[i],
    }));

    await this.initialize();
    const names = await this.db!.tableNames();
    if (names.includes(TABLE_NAME)) {
      // 表已存在：打开后写入全部条款（含首条）
      if (!this.table) {
        this.table = await this.db!.openTable(TABLE_NAME);
      }
      await this.table.add(records);
    } else {
      // 表不存在：用首条建表（会一并写入首条），再补写剩余条款
      const table = await this.db!.createTable(TABLE_NAME, [records[0]], { mode: 'create' });
      this.table = table;
      if (records.length > 1) {
        await table.add(records.slice(1));
      }
    }
  }

  /**
   * 语义搜索
   */
  async search(
    query: string,
    options?: {
      limit?: number;
      category?: string;
      province?: string;
      isMandatory?: boolean;
    }
  ): Promise<SearchResult[]> {
    // 如果表不存在，返回空结果
    await this.initialize();
    if (!this.table) {
      return [];
    }

    const limit = options?.limit ?? 10;

    // 生成查询向量
    const queryVector = await this.embed(query);

    // 构建查询 - 使用 search 方法传入向量
    let queryBuilder = this.table.search(queryVector).limit(limit) as lancedb.VectorQuery;

    // 添加过滤条件
    const filters: string[] = [];
    if (options?.category) {
      filters.push(`category = '${options.category}'`);
    }
    if (options?.province) {
      filters.push(`province = '${options.province}'`);
    }
    if (options?.isMandatory !== undefined) {
      filters.push(`is_mandatory = '${options.isMandatory ? 'true' : 'false'}'`);
    }

    if (filters.length > 0) {
      queryBuilder = queryBuilder.where(filters.join(' AND '));
    }

    const results = await queryBuilder.toArray();

    return results.map((row: any) => ({
      id: row.id,
      regulation: `${row.regulation_code} ${row.regulation_name}`,
      section: row.section,
      content: row.content,
      isMandatory: row.is_mandatory === 'true',
      category: row.category,
      province: row.province,
      score: row._distance ?? 0,
    }));
  }

  /**
   * 按规范 ID 删除所有相关向量
   */
  async deleteByRegulationId(regulationId: string): Promise<void> {
    await this.initialize();
    if (!this.table) return;
    await this.table.delete(`regulation_id = '${regulationId}'`);
  }

  // ============ 方案原文 RAG ============

  /**
   * 将方案文本按段落分块（供专家对话检索原文）
   */
  chunkSchemeText(text: string, reportId: string): SchemeChunk[] {
    const chunks: SchemeChunk[] = [];
    const paragraphs = text
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p.length >= 10);

    const maxChunk = 800;
    const overlap = 120;
    let current = '';
    let index = 0;

    const flush = () => {
      if (current.trim().length >= 10) {
        chunks.push({
          id: `scheme-${reportId}-${index}`,
          report_id: reportId,
          content: current.trim(),
        });
        index++;
      }
    };

    for (const para of paragraphs) {
      if (current.length > 0 && current.length + para.length > maxChunk) {
        flush();
        // 用上一块末尾的 overlap 作为新块开头，保证上下文连续
        const tail = current.length > overlap ? current.slice(-overlap) : current;
        current = tail + '\n' + para;
      } else {
        current += (current ? '\n' : '') + para;
      }
    }
    flush();

    return chunks;
  }

  /**
   * 将方案原文分块写入向量库
   */
  async insertSchemeChunks(chunks: SchemeChunk[]): Promise<void> {
    if (chunks.length === 0) return;

    const texts = chunks.map(c => c.content);
    const embeddings = await this.embedBatch(texts);

    const records = chunks.map((c, i) => ({
      id: c.id,
      report_id: c.report_id,
      content: c.content,
      vector: embeddings[i],
    }));

    await this.initialize();
    const names = await this.db!.tableNames();
    if (names.includes(SCHEME_TABLE)) {
      // 表已存在：打开后写入全部分块（含首块）
      if (!this.schemeTable) {
        this.schemeTable = await this.db!.openTable(SCHEME_TABLE);
      }
      await this.schemeTable.add(records);
    } else {
      // 表不存在：用首条建表（会一并写入首块），再补写剩余块
      const table = await this.db!.createTable(SCHEME_TABLE, [records[0]], { mode: 'create' });
      this.schemeTable = table;
      if (records.length > 1) {
        await table.add(records.slice(1));
      }
    }
  }

  /**
   * 按 reportId 检索最相关的方案原文片段
   */
  async searchSchemeChunks(
    query: string,
    reportId: string,
    limit = 5
  ): Promise<SchemeSearchResult[]> {
    await this.initialize();
    if (!this.schemeTable) {
      const names = await this.db!.tableNames();
      if (!names.includes(SCHEME_TABLE)) return [];
      this.schemeTable = await this.db!.openTable(SCHEME_TABLE);
    }

    const queryVector = await this.embed(query);
    const safeId = reportId.replace(/'/g, "''");
    const results = await this.schemeTable
      .search(queryVector)
      .where(`report_id = '${safeId}'`)
      .limit(limit)
      .toArray();

    return results.map((row: any) => ({
      id: row.id,
      report_id: row.report_id,
      content: row.content,
      score: row._distance ?? 0,
    }));
  }

  /**
   * 删除某个报告关联的全部方案原文向量
   */
  async deleteSchemeByReportId(reportId: string): Promise<void> {
    await this.initialize();
    if (!this.schemeTable) {
      const names = await this.db!.tableNames();
      if (!names.includes(SCHEME_TABLE)) return;
      this.schemeTable = await this.db!.openTable(SCHEME_TABLE);
    }
    const safeId = reportId.replace(/'/g, "''");
    await this.schemeTable.delete(`report_id = '${safeId}'`);
  }

  /**
   * 获取向量总数
   */
  async countRows(): Promise<number> {
    await this.initialize();
    if (!this.table) return 0;
    return this.table.countRows();
  }

  /**
   * 创建向量索引（数据量较大时提升搜索性能）
   */
  async createIndex(): Promise<void> {
    await this.initialize();
    if (!this.table) return;
    await this.table.createIndex('vector');
  }

  /**
   * 获取所有条款（用于兼容现有接口）
   */
  async getAllClauses(): Promise<ClauseChunk[]> {
    await this.initialize();
    if (!this.table) return [];

    const results = await this.table.query().toArray();
    return results.map((row: any) => ({
      id: row.id,
      regulation_id: row.regulation_id,
      regulation_code: row.regulation_code,
      regulation_name: row.regulation_name,
      section: row.section,
      content: row.content,
      is_mandatory: row.is_mandatory,
      category: row.category,
      province: row.province,
    }));
  }

  /**
   * 按省份获取地方法规条款
   */
  async getLocalClausesByProvince(province: string): Promise<string[]> {
    await this.initialize();
    if (!this.table) return [];

    const results = await this.table
      .query()
      .where(`category = 'local' AND province = '${province}'`)
      .toArray();

    return results.map(
      (row: any) => `【${row.regulation_code} ${row.section}】${row.content}`
    );
  }

  /**
   * 获取强条列表
   */
  async getMandatoryClauses(): Promise<string[]> {
    await this.initialize();
    if (!this.table) return [];

    const results = await this.table
      .query()
      .where(`is_mandatory = 'true' AND category != 'local'`)
      .toArray();

    return results.map(
      (row: any) => `【${row.regulation_code} ${row.section}（强条）】${row.content}`
    );
  }
}

// 单例
export const vectorStore = new VectorStore();
