import OpenAI from 'openai';
import { config } from '../config.js';
import type { ProjectInfo, Finding, ChatMessage } from '../../shared/types.js';

export class AIService {
  private client: OpenAI;

  constructor() {
    this.client = new OpenAI({
      apiKey: config.llm.apiKey,
      baseURL: config.llm.baseURL,
    });
  }

  /**
   * Step 0: 提取基本信息
   */
  async extractProjectInfo(documentText: string): Promise<ProjectInfo> {
    const prompt = `你是一个专业的施工方案分析专家。请从以下深基坑支护方案文档中提取项目基本信息。

文档内容：
${documentText}

请以 JSON 格式返回以下信息：
{
  "projectName": "工程名称",
  "province": "省份",
  "city": "城市",
  "supportType": "支护形式（如：桩锚支护、地下连续墙等）",
  "excavationDepth": 开挖深度（数字，单位米）,
  "geologicalConditions": "主要地层，以数字编号，特殊地层（如淤泥质土等）加粗",
  "groundwater": "地下水情况",
  "surroundingEnvironment": "周边环境描述"
}

注意：只返回 JSON 对象，不要有其他文字。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    const content = response.choices[0].message.content || '{}';
    try {
      const json = content.replace(/```json\n?|\n?```/g, '').trim();
      return JSON.parse(json);
    } catch {
      return {
        projectName: '未能解析',
        province: '未知',
        city: '未知',
        supportType: '未知',
        excavationDepth: 0,
        geologicalConditions: '未能解析',
        groundwater: '未能解析',
        surroundingEnvironment: '未能解析',
      };
    }
  }

  /**
   * Step 1: 完整性检查
   */
  async checkCompleteness(documentText: string, projectInfo: ProjectInfo): Promise<Finding[]> {
    const prompt = `你是一位深基坑施工方案审查专家。请根据《危险性较大的分部分项工程专项施工方案编制指南》，检查以下施工方案的完整性。

🚨 重要前提：你审查的是施工方案（施工组织设计类文件），不是设计文件。施工方案的核心是指导现场如何安全施工，而不是进行结构设计验算。

以下内容属于设计阶段工作，不属于施工方案范畴，请勿将其作为缺项或问题提出：
- ❌ 抗突涌验算、抗隆起验算、抗倾覆验算、抗滑移验算
- ❌ 边坡稳定性验算、整体稳定性验算
- ❌ 地基承载力验算、桩基承载力验算
- ❌ 支护结构内力计算、变形计算、配筋计算
- ❌ 降水设计计算（涌水量计算、井点数量计算等）
- ❌ 任何结构设计计算书

你只检查施工方案本身是否完整（是否包含施工组织、质量安全措施、应急预案等），不检查设计计算是否完备，也无需关注专家论证相关条例。

📌 图纸识别规则（非常重要）：
- 当前审查的是从方案文件中提取的文本内容，无法直接查看图片。但方案中的图纸通常会在图片下方标注图名，例如：
  - "施工总平面布置图"、"基坑周边环境平面图"
  - "监测点平面布置图"、"马道收尾示意图"
  - "平面布置图"、"监测平面图"、"剖面图"、"详图"
- ⚠️ 请逐句扫描文本中是否出现了上述图名关键词。如果文本中出现了对应的图名（即使只是图名文字而非图片本身），就说明该图纸已包含在方案中，不应标记为缺失。
- 只有在文本中完全找不到任何相关图名或提及的情况下，才可判定为缺失。

项目信息：
- 工程名称：${projectInfo.projectName}
- 支护形式：${projectInfo.supportType}
- 开挖深度：${projectInfo.excavationDepth}m

方案内容：
${documentText}

请检查以下施工方案应包含的内容是否齐全：
1. 工程概况（基坑周长、面积、开挖深度，基坑支护设计安全等级，基坑设计使用年限，工程地质情况，工程水文地质情况，施工地的气候特征和季节性天气，主要工程量清单，周边环境条件，基坑支护平面、剖面布置，施工降水、帷幕隔水，土方开挖方式及布置，土方开挖与加撑的关系，施工平面布置，明确质量安全目标要求，工期要求，风险辨识与分级，参建各方责任主体单位）
2. 编制依据（相关法律法规、规范标准、设计文件等）
3. 施工计划（施工进度计划具体到各分项工程的进度安排，机械设备配置，主要材料及周转材料需求计划，主要材料投入计划、力学性能要求及取样复试详细要求，试验计划，劳动力计划）
4. 施工工艺技术（技术参数，工艺流程，施工方法及操作要求，检查要求：基坑工程所用的材料进场质量检查、抽检，基坑施工过程中各工序检验内容及检验标准）
5. 施工安全保证措施（组织保障；技术措施；监测监控：监测组织机构，监测范围、监测项目、监测方法、监测频率、预警值及控制值、巡视检查、信息反馈，监测点布置图；季节性施工措施）
6. 施工管理及作业人员配备和分工（管理人员名单及岗位职责，专职安全生产管理人员名单及岗位职责，特种作业人员名单）
7. 验收要求（验收标准、验收程序、验收内容）
8. 应急处置措施（应急处置领导小组组成与职责、应急救援小组组成与职责、联系方式、应急物资、应急响应流程、救援医院信息）
9. 计算书及相关图纸（施工方案需要的施工荷载验算等，非结构设计计算书，如有汽车吊或履带吊则必须有吊重验算、承载力验算、吊索验算；施工总平面布置图、基坑周边环境平面图、监测点平面图、基坑土方开挖示意图、基坑施工顺序示意图、基坑马道收尾示意图等）

返回 JSON 数组，每个缺项或问题一条：
[
  {
    "severity": "critical|major|minor",
    "category": "完整性",
    "title": "缺少XXX",
    "description": "详细描述缺失或不足之处",
    "recommendation": "整改建议"
  }
]

没有问题则返回 []。只返回 JSON 数组，不要其他文字。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    return this.parseFindings(response.choices[0].message.content || '[]', 'step1', '完整性检查');
  }

  /**
   * Step 2: 合规性检查（强条核对）
   */
  async checkCompliance(documentText: string, regulationClauses: string[]): Promise<Finding[]> {
    const clausesText = regulationClauses.slice(0, 20).join('\n---\n');

    const prompt = `你是施工方案审查专家。请核对方案是否违反以下强制性条文（强条）。

强制性条文（JGJ-120、GB-50497、JGJ-94、GB-51004 等）：
${clausesText}

方案内容：
${documentText}

请逐条核对，找出违规、可能违规或未明确响应的强条。

返回 JSON 数组：
[
  {
    "severity": "critical|major",
    "category": "合规性",
    "title": "违反/未响应 [条款编号]：[条款简述]",
    "description": "方案中的具体问题描述",
    "location": "方案中的章节或位置",
    "recommendation": "整改建议"
  }
]

完全合规则返回 []。只返回 JSON 数组。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
    });

    return this.parseFindings(response.choices[0].message.content || '[]', 'step2', '合规性检查');
  }

  /**
   * Step 3: 支护专项检查
   */
  async checkSupportSpecific(documentText: string, projectInfo: ProjectInfo): Promise<Finding[]> {
    const supportTypePrompts: Record<string, string> = {
      '桩锚': '检查钢筋笼吊装、泥浆处理、锚杆施工工艺、张拉锁定工序、施工质量控制措施',
      '地下连续墙': '检查成槽工艺、钢筋笼吊装、混凝土浇筑、接头处理施工措施',
      '土钉墙': '检查土钉成孔与安装、注浆工艺、喷射混凝土面层施工、分层开挖配合',
      '钢板桩': '检查打桩方式、锁口处理、支撑安装与拆除、拔桩工艺',
      default: '检查支护结构施工工艺、施工顺序、质量控制、与土方开挖的配合',
    };

    const supportHint = Object.keys(supportTypePrompts).find(k => projectInfo.supportType.includes(k))
      ? supportTypePrompts[Object.keys(supportTypePrompts).find(k => projectInfo.supportType.includes(k))!]
      : supportTypePrompts['default'];

    const prompt = `你是一位深基坑施工方案审查专家。请针对"${projectInfo.supportType}"类型的施工方案进行专项检查。

🚨 重要前提：你审查的是施工方案（施工组织文件），不是设计方案。施工方案关注的是"如何安全、正确地按图施工"，而不是"结构参数是否设计合理"。设计参数（如桩径、间距、嵌固深度等）由设计单位负责并已包含在设计文件中。

以下内容属于设计计算范畴，不属于施工方案审查范围，请勿提出：
- ❌ 抗突涌验算、抗隆起验算、抗倾覆验算、抗滑移验算
- ❌ 边坡稳定性验算、整体稳定性验算
- ❌ 支护结构内力/变形/配筋计算

📌 图纸识别规则：方案中的图纸通常以图名形式出现在文本中（如"监测点平面布置图"、"施工顺序示意图"等），请扫描文本中的图名，如已出现则视为图纸存在，勿标记为缺失。

项目信息：
- 支护形式：${projectInfo.supportType}
- 开挖深度：${projectInfo.excavationDepth}m
- 地质条件：${projectInfo.geologicalConditions}
- 地下水：${projectInfo.groundwater}
- 周边环境：${projectInfo.surroundingEnvironment}

专项检查重点：${supportHint}

方案内容：
${documentText}

请从施工方案角度检查以下内容：
1. 施工方法是否合理可行，是否与支护类型和地质条件匹配
2. 施工顺序是否正确（如分层开挖、先撑后挖、严禁超挖等原则是否体现）
3. 施工机械选择是否满足工程需求
4. 施工质量控制措施是否到位（材料检验、工序检查、验收标准）
5. 与支护结构施工相关的安全风险控制措施
6. 施工对周边环境（建筑物、管线、道路）的保护措施是否充分
7. 地下水控制施工措施（降水、排水、截水）是否明确
8. 监测方案中施工期间的监测频率、测点布置、预警值是否合理
9. 应急预案中针对支护结构施工可能出现的险情（如变形突变、涌水涌砂、坍塌）是否有具体处置措施

返回 JSON 数组：
[
  {
    "severity": "critical|major|minor",
    "category": "支护专项",
    "title": "问题标题",
    "description": "详细问题描述",
    "recommendation": "整改建议"
  }
]

只返回 JSON 数组。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    return this.parseFindings(response.choices[0].message.content || '[]', 'step3', '支护专项检查');
  }

  /**
   * Step 4: 地方法规审查
   */
  async checkLocalRegulations(documentText: string, projectInfo: ProjectInfo, localClauses: string[]): Promise<Finding[]> {
    const clausesText = localClauses.length > 0
      ? localClauses.slice(0, 10).join('\n---\n')
      : `${projectInfo.province}暂无已上传的地方法规`;

    const prompt = `你是熟悉${projectInfo.province}地方建设法规的专家。请检查施工方案是否符合地方要求。

🚨 重要前提：你审查的是施工方案文件。不要将设计计算内容（如抗突涌验算、边坡稳定验算、承载力验算等）作为施工方案的审查项。

项目地点：${projectInfo.province} ${projectInfo.city}

地方法规/标准要求：
${clausesText}

方案内容：
${documentText}

请检查：
1. 是否符合${projectInfo.province}地方施工方案报审要求
2. 是否符合${projectInfo.city}地方建设主管部门要求
3. 特殊地质（如岩溶、湿陷性黄土、软土等）是否有针对性措施
4. 地方特有的技术要求和强制性规定

返回 JSON 数组：
[
  {
    "severity": "critical|major|minor",
    "category": "地方法规",
    "title": "问题标题",
    "description": "具体问题",
    "recommendation": "整改建议"
  }
]

只返回 JSON 数组。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
    });

    return this.parseFindings(response.choices[0].message.content || '[]', 'step4', '地方法规审查');
  }

  /**
   * Step 5: 汇总报告生成
   */
  async generateSummaryReport(
    projectInfo: ProjectInfo,
    allFindings: Finding[]
  ): Promise<{ score: number; assessment: string }> {
    const criticalCount = allFindings.filter(f => f.severity === 'critical').length;
    const majorCount = allFindings.filter(f => f.severity === 'major').length;
    const minorCount = allFindings.filter(f => f.severity === 'minor').length;

    const findingsSummary = allFindings.map(f =>
      `[${f.severity.toUpperCase()}] ${f.title}: ${f.description}`
    ).join('\n');

    const prompt = `你是深基坑工程专家。请根据施工方案审查结果生成综合评估意见。

审查对象：施工方案（非设计文件），不涉及结构设计验算。

项目：${projectInfo.projectName}
支护形式：${projectInfo.supportType}
开挖深度：${projectInfo.excavationDepth}m

审查发现（共 ${allFindings.length} 项）：
- 严重问题（critical）：${criticalCount} 项
- 重要问题（major）：${majorCount} 项
- 一般问题（minor）：${minorCount} 项

问题清单：
${findingsSummary.substring(0, 3000)}

请返回 JSON 格式：
{
  "score": 评分（0-100整数，根据问题数量和严重程度评定），
  "assessment": "综合评估意见（200字以内，包含：整体评价、主要风险、整改优先级建议）"
}

只返回 JSON。`;

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    });

    try {
      const content = response.choices[0].message.content || '{}';
      const json = content.replace(/```json\n?|\n?```/g, '').trim();
      return JSON.parse(json);
    } catch {
      const score = Math.max(0, 100 - criticalCount * 20 - majorCount * 8 - minorCount * 2);
      return {
        score,
        assessment: `方案共发现 ${allFindings.length} 项问题，其中严重 ${criticalCount} 项，重要 ${majorCount} 项，一般 ${minorCount} 项。请按严重程度优先整改。`,
      };
    }
  }

  /**
   * 专家对话
   */
  async chat(
    userMessage: string,
    reportContext: string,
    schemeContext: string,
    history: ChatMessage[]
  ): Promise<string> {
    const schemeSection = schemeContext
      ? `\n📄 方案原文片段（语义检索自用户上传的方案文档，是回答"方案里怎么写的"类问题的权威依据，应优先引用）：\n${schemeContext}\n`
      : '';

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `你是深基坑支护工程施工方案审查专家。请基于以下审核报告和方案原文回答用户问题。

注意：审查对象是施工方案（施工组织文件），不是设计文件。不涉及结构设计计算（如抗突涌验算、边坡稳定验算、承载力验算等）。

审核报告：
${reportContext}
${schemeSection}
请：
1. 当用户询问"方案里/方案中怎么写的/如何规定的"等涉及原文的问题时，优先从"方案原文片段"中引用原文作答，并标明出处（如【方案原文 1】），不要凭空编造。
2. 结合审核报告的 findings 进行解读和分析。
3. 如果原文片段中没有相关信息，请根据审核报告或专业知识回答并说明来源。
4. 回答要专业、简洁、实用`,
      },
      ...history.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    const response = await this.client.chat.completions.create({
      model: config.llm.model,
      messages,
      temperature: 0.4,
    });

    return response.choices[0].message.content || '抱歉，无法生成回复。';
  }

  /**
   * 解析 AI 返回的 Finding JSON
   */
  private parseFindings(content: string, stepPrefix: string, stepName: string): Finding[] {
    try {
      const json = content.replace(/```json\n?|\n?```/g, '').trim();
      const parsed = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((f: any, index: number) => ({
        id: `${stepPrefix}-${index}`,
        stepName,
        severity: f.severity || 'minor',
        category: f.category || stepName,
        title: f.title || '未知问题',
        description: f.description || '',
        location: f.location,
        recommendation: f.recommendation,
      }));
    } catch {
      return [];
    }
  }
}
