/**
 * HTML Reporter — generates a standalone HTML report.
 * No external dependencies — CSS/JS embedded inline.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPProbeReport, ServerReport } from './schema.js';
import type { SuiteResult, TestResult } from '../plugin/types.js';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusIcon(status: string): string {
  switch (status) {
    case 'passed': return '<span class="icon pass">PASS</span>';
    case 'failed': return '<span class="icon fail">FAIL</span>';
    case 'skipped': return '<span class="icon skip">SKIP</span>';
    case 'errored': return '<span class="icon error">ERR</span>';
    default: return status;
  }
}

function gradeClass(grade: string): string {
  if (grade === 'A') return 'grade-a';
  if (grade === 'B') return 'grade-b';
  if (grade === 'C') return 'grade-c';
  return 'grade-f';
}

function renderTest(test: TestResult): string {
  const assertionsHtml = test.assertions
    .map((a) => {
      const cls = a.passed ? 'assertion-pass' : (a.severity === 'warning' ? 'assertion-warn' : 'assertion-fail');
      return `<div class="assertion ${cls}"><strong>${escapeHtml(a.name)}</strong>: ${escapeHtml(a.message)}</div>`;
    })
    .join('');

  const errorHtml = test.error
    ? `<div class="test-error"><pre>${escapeHtml(test.error.message)}</pre></div>`
    : '';

  return `
    <div class="test test-${test.status}">
      <div class="test-header">
        ${statusIcon(test.status)}
        <span class="test-name">${escapeHtml(test.testName)}</span>
        <span class="test-duration">${test.durationMs}ms</span>
      </div>
      <div class="test-details">${assertionsHtml}${errorHtml}</div>
    </div>`;
}

function renderSuite(suite: SuiteResult): string {
  const testsHtml = suite.tests.map(renderTest).join('');
  return `
    <div class="suite">
      <h3>${escapeHtml(suite.suiteName)}
        <span class="suite-stats">${suite.passed}P / ${suite.failed}F / ${suite.skipped}S / ${suite.errored}E</span>
      </h3>
      ${testsHtml}
    </div>`;
}

function renderServer(server: ServerReport): string {
  if (!server.connected) {
    return `
      <div class="server server-error">
        <h2>${escapeHtml(server.serverName)} <span class="connection-error">Connection Failed</span></h2>
        <p>${escapeHtml(server.connectionError ?? 'Unknown error')}</p>
      </div>`;
  }

  const scoreHtml = server.score
    ? `<div class="score ${gradeClass(server.score.grade)}">
         <span class="grade">${server.score.grade}</span>
         <span class="pct">${server.score.percentage}%</span>
         <span class="counts">${server.score.passed}/${server.score.total}</span>
       </div>`
    : '';

  const infoHtml = server.discovered
    ? `<div class="server-info">
         ${server.discovered.serverInfo.name} v${server.discovered.serverInfo.version}
         | Protocol: ${server.discovered.protocolVersion}
         | Tools: ${server.discovered.toolCount}, Resources: ${server.discovered.resourceCount}, Prompts: ${server.discovered.promptCount}
       </div>`
    : '';

  const suitesHtml = server.suites.map(renderSuite).join('');

  return `
    <div class="server">
      <div class="server-header">
        <h2>${escapeHtml(server.serverName)}</h2>
        ${scoreHtml}
      </div>
      ${infoHtml}
      ${suitesHtml}
    </div>`;
}

function generateHtml(report: MCPProbeReport): string {
  const serversHtml = report.servers.map(renderServer).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>MCP Probe Report</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 2rem; }
  h1 { color: #58a6ff; margin-bottom: 0.5rem; }
  .meta { color: #8b949e; margin-bottom: 2rem; font-size: 0.9rem; }
  .server { background: #161b22; border: 1px solid #30363d; border-radius: 8px; margin-bottom: 1.5rem; padding: 1.5rem; }
  .server-error { border-color: #f85149; }
  .server-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .server-header h2 { color: #f0f6fc; }
  .server-info { color: #8b949e; font-size: 0.85rem; margin-bottom: 1rem; padding: 0.5rem; background: #0d1117; border-radius: 4px; }
  .connection-error { color: #f85149; font-size: 0.8rem; }
  .score { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem 1rem; border-radius: 6px; font-weight: bold; }
  .grade { font-size: 1.5rem; }
  .grade-a { background: #1a3a2a; color: #3fb950; }
  .grade-b { background: #2a3a1a; color: #a3d977; }
  .grade-c { background: #3a3a1a; color: #d29922; }
  .grade-f { background: #3a1a1a; color: #f85149; }
  .suite { margin-top: 1rem; }
  .suite h3 { color: #58a6ff; font-size: 1rem; margin-bottom: 0.5rem; display: flex; justify-content: space-between; }
  .suite-stats { color: #8b949e; font-size: 0.85rem; font-weight: normal; }
  .test { border-left: 3px solid #30363d; padding: 0.5rem 1rem; margin-bottom: 0.5rem; }
  .test-passed { border-color: #3fb950; }
  .test-failed { border-color: #f85149; }
  .test-skipped { border-color: #8b949e; }
  .test-errored { border-color: #d29922; }
  .test-header { display: flex; align-items: center; gap: 0.5rem; }
  .test-name { font-size: 0.9rem; }
  .test-duration { color: #8b949e; font-size: 0.8rem; margin-left: auto; }
  .icon { font-size: 0.7rem; padding: 2px 6px; border-radius: 3px; font-weight: bold; }
  .pass { background: #1a3a2a; color: #3fb950; }
  .fail { background: #3a1a1a; color: #f85149; }
  .skip { background: #1a1a2a; color: #8b949e; }
  .error { background: #3a2a1a; color: #d29922; }
  .test-details { margin-top: 0.3rem; padding-left: 1rem; }
  .assertion { font-size: 0.8rem; padding: 2px 0; }
  .assertion-pass { color: #3fb950; }
  .assertion-fail { color: #f85149; }
  .assertion-warn { color: #d29922; }
  .test-error pre { background: #0d1117; padding: 0.5rem; border-radius: 4px; font-size: 0.8rem; color: #f85149; overflow-x: auto; }
</style>
</head>
<body>
  <h1>MCP Probe Report</h1>
  <div class="meta">
    Run: ${report.runId.slice(0, 8)} | ${report.timestamp} | ${report.duration}ms | ${report.config.serverCount} server(s)
  </div>
  ${serversHtml}
</body>
</html>`;
}

export function writeHtmlReport(report: MCPProbeReport, outputDir: string): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const filename = `mcp-probe-${report.runId.slice(0, 8)}.html`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, generateHtml(report));
  return filePath;
}
