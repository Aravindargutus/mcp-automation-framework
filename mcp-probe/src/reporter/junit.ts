/**
 * JUnit XML Reporter — writes the MCPProbeReport as JUnit XML.
 *
 * Generates standard JUnit XML format compatible with GitHub Actions,
 * Jenkins, GitLab CI, and other CI systems.
 *
 * Mapping:
 *   MCPProbeReport → <testsuites>
 *   SuiteResult → <testsuite>
 *   TestResult → <testcase>
 *   Failed assertion → <failure>
 *   Errored test → <error>
 *   Skipped test → <skipped>
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MCPProbeReport } from './schema.js';
import type { TestResult } from '../plugin/types.js';

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a single test case as JUnit XML.
 */
function renderTestCase(test: TestResult, suiteName: string): string {
  const classname = escapeXml(`${suiteName}`);
  const name = escapeXml(test.testName);
  const time = (test.durationMs / 1000).toFixed(3);

  let inner = '';

  if (test.status === 'skipped') {
    const skipMsg = test.assertions.find((a) => a.severity === 'info')?.message ?? 'Skipped';
    inner = `      <skipped message="${escapeXml(skipMsg)}" />\n`;
  } else if (test.status === 'errored') {
    const errorMsg = test.error?.message ?? 'Unknown error';
    const errorStack = test.error?.stack ?? '';
    inner = `      <error message="${escapeXml(errorMsg)}" type="Error">${escapeXml(errorStack)}</error>\n`;
  } else if (test.status === 'failed') {
    const failedAssertions = test.assertions.filter((a) => !a.passed && a.severity === 'error');
    for (const assertion of failedAssertions) {
      const msg = `${assertion.name}: ${assertion.message}`;
      inner += `      <failure message="${escapeXml(msg)}" type="AssertionFailure">${escapeXml(msg)}</failure>\n`;
    }
  }

  return `    <testcase classname="${classname}" name="${name}" time="${time}">\n${inner}    </testcase>\n`;
}

/**
 * Write a JUnit XML report file.
 */
export function writeJunitReport(report: MCPProbeReport, outputDir: string): string {
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += `<testsuites name="MCP Probe" time="${(report.duration / 1000).toFixed(3)}" `;
  xml += `timestamp="${escapeXml(report.timestamp)}">\n`;

  for (const server of report.servers) {
    if (!server.connected) {
      // Connection failure → single errored test suite
      xml += `  <testsuite name="${escapeXml(server.serverName)}" tests="1" failures="0" errors="1" skipped="0" time="0">\n`;
      xml += `    <testcase classname="${escapeXml(server.serverName)}" name="connection" time="0">\n`;
      xml += `      <error message="${escapeXml(server.connectionError ?? 'Connection failed')}" type="ConnectionError" />\n`;
      xml += `    </testcase>\n`;
      xml += `  </testsuite>\n`;
      continue;
    }

    for (const suite of server.suites) {
      const name = escapeXml(`${server.serverName}.${suite.suiteName}`);
      const tests = suite.tests.length;
      const failures = suite.failed;
      const errors = suite.errored;
      const skipped = suite.skipped;
      const time = (suite.durationMs / 1000).toFixed(3);

      xml += `  <testsuite name="${name}" tests="${tests}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${time}">\n`;

      for (const test of suite.tests) {
        xml += renderTestCase(test, `${server.serverName}.${suite.suiteName}`);
      }

      xml += `  </testsuite>\n`;
    }
  }

  xml += '</testsuites>\n';

  const filename = `mcp-probe-${report.runId.slice(0, 8)}.xml`;
  const filePath = join(outputDir, filename);
  writeFileSync(filePath, xml);
  return filePath;
}
