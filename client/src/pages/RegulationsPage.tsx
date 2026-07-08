import React, { useEffect, useState } from 'react';
import { apiFetch } from '../api';
import type { Regulation } from '../types';
import './RegulationsPage.css';

interface LLMSearchResult {
  summary: string;
  results: Array<{
    source: string;
    section: string;
    content: string;
    isMandatory: boolean;
    relevance: string;
  }>;
  rawCount: number;
}

const RegulationsPage: React.FC = () => {
  const [regulations, setRegulations] = useState<Regulation[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [searchResults, setSearchResults] = useState<LLMSearchResult | null>(null);
  const [searching, setSearching] = useState(false);

  const [form, setForm] = useState({
    name: '',
    code: '',
    category: 'national' as 'national' | 'industry' | 'local',
    province: '',
    file: null as File | null,
  });
  const [uploading, setUploading] = useState(false);

  const loadRegulations = async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/api/regulations');
      const data = await res.json();
      setRegulations(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRegulations();
  }, []);

  const handleUpload = async () => {
    if (!form.file || !form.name || !form.code) {
      alert('请填写规范名称、编号并选择文件');
      return;
    }
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', form.file);
      formData.append('name', form.name);
      formData.append('code', form.code);
      formData.append('category', form.category);
      if (form.province) formData.append('province', form.province);

      const res = await apiFetch('/api/regulations/upload', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      setUploadOpen(false);
      setForm({ name: '', code: '', category: 'national', province: '', file: null });
      loadRegulations();
    } catch (e: any) {
      alert(`上传失败: ${e.message}`);
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确定删除此法规？')) return;
    await apiFetch(`/api/regulations/${id}`, { method: 'DELETE' });
    loadRegulations();
  };

  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!searchKeyword.trim()) return;
    setSearching(true);
    setSearchResults(null);
    setSearchError(null);
    try {
      const res = await apiFetch(`/api/regulations/search?keyword=${encodeURIComponent(searchKeyword)}`);
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `服务器错误 (${res.status})`);
      }
      const data = await res.json();
      setSearchResults(data);
    } catch (e: any) {
      setSearchError(e.message || '搜索失败，请重试');
    } finally {
      setSearching(false);
    }
  };

  const categoryLabel = (cat: string) => {
    return { national: '国家标准', industry: '行业标准', local: '地方标准' }[cat] || cat;
  };

  return (
    <div className="regulations-page">
      <div className="page-header">
        <h1 className="page-title">法规库</h1>
        <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
          + 上传法规
        </button>
      </div>

      {/* 搜索区域 */}
      <div className="card search-card">
        <div className="search-bar">
          <input
            type="text"
            placeholder="搜索法规条款（如：锚杆、嵌固深度、强条...）"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="search-input"
          />
          <button className="btn btn-primary" onClick={handleSearch} disabled={searching}>
            {searching ? <div className="spinner" /> : '搜索'}
          </button>
        </div>
        {searchError && (
          <div className="search-error">{searchError}</div>
        )}
        {searchResults && (
          <div className="search-results">
            <div className="search-results-header">
              <h4 className="search-results-title">AI 分析结果</h4>
              <span className="search-results-count">从 {searchResults.rawCount} 条原始结果中筛选</span>
            </div>
            <div className="search-summary">{searchResults.summary}</div>
            {searchResults.results.length === 0 ? (
              <div className="search-no-results">未找到相关内容</div>
            ) : (
              searchResults.results.map((r, i) => (
                <div key={i} className="search-result-item">
                  <div className="search-result-source">
                    {r.source} · {r.section}
                    {r.isMandatory && <span className="mandatory-badge">强条</span>}
                  </div>
                  <p className="search-result-content">{r.content}</p>
                  {r.relevance && <p className="search-result-relevance">💡 {r.relevance}</p>}
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* 法规列表 */}
      {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>加载中...</div>}

      {!loading && regulations.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">📚</div>
          <div className="empty-state-text">暂无法规，请上传 JGJ 120、GB 50497 等规范文件</div>
        </div>
      )}

      <div className="regulations-grid">
        {regulations.map(reg => (
          <div key={reg.id} className="regulation-card card">
            <div className="reg-card-header">
              <span className={`category-badge cat-${reg.category}`}>{categoryLabel(reg.category)}</span>
              {reg.province && <span className="province-badge">{reg.province}</span>}
            </div>
            <div className="reg-code">{reg.code}</div>
            <div className="reg-name">{reg.name}</div>
            <div className="reg-stats">
              <span>{reg.chunkCount ?? reg.clauses.length} 个分块</span>
            </div>
            <div className="reg-date">{new Date(reg.uploadedAt).toLocaleDateString('zh-CN')}</div>
            <button
              className="btn btn-danger"
              style={{ fontSize: 12, padding: '4px 12px', marginTop: 12 }}
              onClick={() => handleDelete(reg.id)}
            >
              删除
            </button>
          </div>
        ))}
      </div>

      {/* 上传对话框 */}
      {uploadOpen && (
        <div className="modal-overlay" onClick={() => setUploadOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2 className="modal-title">上传法规文件</h2>

            <div className="form-group">
              <label>规范名称 *</label>
              <input
                type="text"
                placeholder="如：建筑基坑支护技术规程"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>规范编号 *</label>
              <input
                type="text"
                placeholder="如：JGJ 120-2012"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
              />
            </div>

            <div className="form-group">
              <label>类别</label>
              <select
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value as any })}
              >
                <option value="national">国家标准</option>
                <option value="industry">行业标准</option>
                <option value="local">地方标准</option>
              </select>
            </div>

            {form.category === 'local' && (
              <div className="form-group">
                <label>适用省份</label>
                <input
                  type="text"
                  placeholder="如：广东省"
                  value={form.province}
                  onChange={(e) => setForm({ ...form, province: e.target.value })}
                />
              </div>
            )}

            <div className="form-group">
              <label>文件 (PDF/DOCX) *</label>
              <input
                type="file"
                accept=".pdf,.docx"
                onChange={(e) => e.target.files && setForm({ ...form, file: e.target.files[0] })}
              />
            </div>

            <div className="modal-actions">
              <button className="btn btn-primary" onClick={handleUpload} disabled={uploading}>
                {uploading ? <><div className="spinner" /> 解析中...</> : '上传并解析'}
              </button>
              <button className="btn btn-ghost" onClick={() => setUploadOpen(false)}>取消</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default RegulationsPage;
