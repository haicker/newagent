import React from 'react';
import ReviewPage from './pages/ReviewPage';
import RegulationsPage from './pages/RegulationsPage';
import ReportsPage from './pages/ReportsPage';
import { useAppStore } from './store';
import './App.css';

const App: React.FC = () => {
  const { currentPage, setCurrentPage } = useAppStore();

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-logo">
          <img src="/footlogo.png" alt="logo" className="logo-icon" />
          <span className="logo-text">深基坑支护方案审核系统</span>
        </div>
        <nav className="header-nav">
          <button
            className={`nav-btn ${currentPage === 'review' ? 'active' : ''}`}
            onClick={() => setCurrentPage('review')}
          >
            方案审核
          </button>
          <button
            className={`nav-btn ${currentPage === 'reports' ? 'active' : ''}`}
            onClick={() => setCurrentPage('reports')}
          >
            历史报告
          </button>
          <button
            className={`nav-btn ${currentPage === 'regulations' ? 'active' : ''}`}
            onClick={() => setCurrentPage('regulations')}
          >
            法规库
          </button>
        </nav>
      </header>

      <main className="app-main">
        {currentPage === 'review' && <ReviewPage />}
        {currentPage === 'reports' && <ReportsPage />}
        {currentPage === 'regulations' && <RegulationsPage />}
      </main>
    </div>
  );
};

export default App;
