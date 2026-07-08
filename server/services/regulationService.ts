import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import { config } from '../config.js';
import { FileParser } from '../utils/fileParser.js';
import { vectorStore } from './vectorStore.js';
import type { Regulation, VectorSearchResult } from '../../shared/types.js';

export class RegulationService {
  private llmClient: OpenAI;

  constructor() {
    this.llmClient = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
    });
  }

  /**
   * 解析上传的法规文件，分块并向量化存储
   */
  async parseRegulation(
    filePath: string,
    mimeType: string,
    name: string,
    code: string,
    category: 'national' | 'industry' | 'local',
    province?: string
  ): Promise<Regulation> {
    const rawText = await FileParser.parseFile(filePath, mimeType);
    const cleanedText = FileParser.cleanText(rawText);

    // 1. 文本分块
    const regulationId = `reg-${Date.now()}`;
    const chunks = vectorStore.chunkText(
      cleanedText,
      regulationId,
      code,
      name,
      category,
      province
    );

    // 2. 向量化并存入 LanceDB
    await vectorStore.insertChunks(chunks);

    const regulation: Regulation = {
      id: regulationId,
      name,
      code,
      category,
      province,
      clauses: [],
      uploadedAt: new Date().toISOString(),
      chunkCount: chunks.length,
    };

    // 3. 保存 JSON 摘要（仅元数据）
    await this.saveRegulation(regulation);

    // 4. 数据量较大时自动创建索引
    const totalRows = await vectorStore.countRows();
    if (totalRows > 100) {
      try {
        await vectorStore.createIndex();
      } catch {
        // 索引创建失败不影响功能
      }
    }

    return regulation;
  }

  /**
   * 获取所有法规
   */
  async getAllRegulations(): Promise<Regulation[]> {
    try {
      await fs.mkdir(config.paths.regulations, { recursive: true });
      const files = await fs.readdir(config.paths.regulations);
      const regulations: Regulation[] = [];

      for (const file of files) {
        if (file.endsWith('.json')) {
          const content = await fs.readFile(
            path.join(config.paths.regulations, file),
            'utf-8'
          );
          regulations.push(JSON.parse(content));
        }
      }

      return regulations.sort((a, b) =>
        new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      );
    } catch {
      return [];
    }
  }

  /**
   * 按省份获取地方法规条款文本列表（从向量库查询）
   */
  async getLocalClausesByProvince(province: string): Promise<string[]> {
    return vectorStore.getLocalClausesByProvince(province);
  }

  /**
   * 获取国家/行业标准强条文本列表（从向量库查询）
   */
  async getMandatoryClauses(): Promise<string[]> {
    return vectorStore.getMandatoryClauses();
  }

  /**
   * 语义搜索相关条款（向量搜索，返回原始片段）
   */
  async searchClauses(
    keyword: string,
    options?: {
      limit?: number;
      category?: string;
      province?: string;
      isMandatory?: boolean;
    }
  ): Promise<VectorSearchResult[]> {
    return vectorStore.search(keyword, {
      limit: options?.limit ?? 10,
      category: options?.category,
      province: options?.province,
      isMandatory: options?.isMandatory,
    });
  }

  /**
   * LLM 增强搜索：先向量检索，再由 LLM 提取有效信息并生成结构化回答
   */
  async searchWithLLM(
    keyword: string,
    options?: {
      limit?: number;
      category?: string;
      province?: string;
      isMandatory?: boolean;
    }
  ): Promise<{
    summary: string;
    results: Array<{
      source: string;
      section: string;
      content: string;
      isMandatory: boolean;
      relevance: string;
    }>;
    rawCount: number;
  }> {
    // 1. 向量检索（多取一些供 LLM 筛选）
    const rawResults = await vectorStore.search(keyword, {
      limit: (options?.limit ?? 5) * 3,
      category: options?.category,
      province: options?.province,
      isMandatory: options?.isMandatory,
    });

    if (rawResults.length === 0) {
      return {
        summary: '未找到相关条款，请尝试其他关键词。',
        results: [],
        rawCount: 0,
      };
    }

    // 2. 构建上下文
    const context = rawResults
      .map(
        (r, i) =>
          `[${i + 1}] 来源：${r.regulation} ${r.section}${r.isMandatory ? '（强条）' : ''}\n内容：${r.content}`
      )
      .join('\n\n');

    // 3. 调用 LLM 提取有效信息
    const prompt = `你是一个建筑规范专家。用户搜索了"${keyword}"，以下是向量数据库检索到的相关条款片段。

请仔细阅读这些内容，完成以下任务：
1. 筛选出与用户搜索关键词真正相关的条款（去除无关内容）
2. 对每条相关内容，用简洁清晰的语言总结要点
3. 如果是强条（强制性条文），必须标注
4. 如果多条条款说的是同一件事，合并说明

检索到的条款：
${context}

请返回 JSON 格式：
{
  "summary": "简要概述找到的相关内容（100字以内）",
  "results": [
    {
      "source": "规范名称+条款号",
      "section": "条款编号",
      "content": "条款核心内容（简洁、易读）",
      "isMandatory": true/false,
      "relevance": "与搜索关键词的相关性说明"
    }
  ]
}

只返回 JSON，不要其他文字。`;

    try {
      const response = await this.llmClient.chat.completions.create({
        model: config.llm.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      });

      const content = response.choices[0].message.content || '{}';
      const json = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(json);

      return {
        summary: parsed.summary || '',
        results: parsed.results || [],
        rawCount: rawResults.length,
      };
    } catch {
      // LLM 失败时降级为原始结果
      return {
        summary: `找到 ${rawResults.length} 条相关条款`,
        results: rawResults.slice(0, options?.limit ?? 5).map(r => ({
          source: r.regulation,
          section: r.section,
          content: r.content,
          isMandatory: r.isMandatory,
          relevance: '',
        })),
        rawCount: rawResults.length,
      };
    }
  }

  /**
   * 删除法规（同时删除向量库中的数据）
   */
  async deleteRegulation(id: string): Promise<void> {
    const filePath = path.join(config.paths.regulations, `${id}.json`);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件可能不存在，忽略
    }

    try {
      await vectorStore.deleteByRegulationId(id);
    } catch {
      // 向量库可能未初始化或数据不存在，忽略
    }
  }

  /**
   * 获取向量库统计信息
   */
  async getVectorStats(): Promise<{ totalChunks: number }> {
    try {
      const totalChunks = await vectorStore.countRows();
      return { totalChunks };
    } catch {
      return { totalChunks: 0 };
    }
  }

  private async saveRegulation(regulation: Regulation): Promise<void> {
    await fs.mkdir(config.paths.regulations, { recursive: true });
    const filePath = path.join(config.paths.regulations, `${regulation.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(regulation, null, 2), 'utf-8');
  }
}
