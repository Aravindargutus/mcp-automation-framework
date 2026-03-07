/**
 * Compare Command — diff two MCP Probe JSON reports.
 *
 * Detects regressions (passed→failed), improvements (failed→passed),
 * and new/removed tests between two runs.
 *
 * Usage: mcp-probe compare <old.json> <new.json>
 * Exit code: 1 if regressions exist, 0 otherwise.
 */
import { readFileSync } from 'node:fs';
import chalk from 'chalk';
import type { MCPProbeReport } from '../reporter/schema.js';

export interface CompareResult {
  regressions: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  improvements: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  newTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  removedTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  gradeChanges: Array<{ serverName: string; oldGrade: string; newGrade: string; oldPct: number; newPct: number }>;
}

/**
 * Extract a flat map of testId → status from a report.
 */
function extractTestMap(report: MCPProbeReport): Map<string, { status: string; testName: string; suiteName: string; serverName: string }> {
  const map = new Map<string, { status: string; testName: string; suiteName: string; serverName: string }>();
  for (const server of report.servers) {
    for (const suite of server.suites) {
      for (const test of suite.tests) {
        const key = `${server.serverName}::${suite.suiteName}::${test.testId}`;
        map.set(key, {
          status: test.status,
          testName: test.testName,
          suiteName: suite.suiteName,
          serverName: server.serverName,
        });
      }
    }
  }
  return map;
}

/**
 * Compare two MCP Probe reports and return diff.
 */
export function compareReports(oldReport: MCPProbeReport, newReport: MCPProbeReport): CompareResult {
  const oldMap = extractTestMap(oldReport);
  const newMap = extractTestMap(newReport);

  const result: CompareResult = {
    regressions: [],
    improvements: [],
    newTests: [],
    removedTests: [],
    gradeChanges: [],
  };

  // Find regressions and improvements
  for (const [key, newInfo] of newMap) {
    const oldInfo = oldMap.get(key);
    if (!oldInfo) {
      result.newTests.push({ testId: key, ...newInfo });
      continue;
    }

    if (oldInfo.status === 'passed' && (newInfo.status === 'failed' || newInfo.status === 'errored')) {
      result.regressions.push({ testId: key, ...newInfo });
    } else if ((oldInfo.status === 'failed' || oldInfo.status === 'errored') && newInfo.status === 'passed') {
      result.improvements.push({ testId: key, ...newInfo });
    }
  }

  // Find removed tests
  for (const [key, oldInfo] of oldMap) {
    if (!newMap.has(key)) {
      result.removedTests.push({ testId: key, ...oldInfo });
    }
  }

  // Compare grades
  for (const newServer of newReport.servers) {
    const oldServer = oldReport.servers.find((s) => s.serverName === newServer.serverName);
    if (oldServer?.score && newServer.score) {
      if (oldServer.score.grade !== newServer.score.grade) {
        result.gradeChanges.push({
          serverName: newServer.serverName,
          oldGrade: oldServer.score.grade,
          newGrade: newServer.score.grade,
          oldPct: oldServer.score.percentage,
          newPct: newServer.score.percentage,
        });
      }
    }
  }

  return result;
}

/**
 * CLI action for the compare command.
 */
export function runCompare(oldPath: string, newPath: string): void {
  try {
    const oldReport = JSON.parse(readFileSync(oldPath, 'utf-8')) as MCPProbeReport;
    const newReport = JSON.parse(readFileSync(newPath, 'utf-8')) as MCPProbeReport;

    const result = compareReports(oldReport, newReport);

    console.log(chalk.blue('\n  MCP Probe — Run Comparison\n'));

    // Grade changes
    if (result.gradeChanges.length > 0) {
      console.log(chalk.yellow('  Grade Changes:'));
      for (const gc of result.gradeChanges) {
        const arrow = gc.newPct >= gc.oldPct ? chalk.green('↑') : chalk.red('↓');
        console.log(`    ${gc.serverName}: ${gc.oldGrade} (${gc.oldPct}%) ${arrow} ${gc.newGrade} (${gc.newPct}%)`);
      }
      console.log();
    }

    // Regressions
    if (result.regressions.length > 0) {
      console.log(chalk.red(`  Regressions (${result.regressions.length}):`));
      for (const r of result.regressions) {
        console.log(chalk.red(`    ✗ ${r.serverName} › ${r.suiteName} › ${r.testName}`));
      }
      console.log();
    }

    // Improvements
    if (result.improvements.length > 0) {
      console.log(chalk.green(`  Improvements (${result.improvements.length}):`));
      for (const r of result.improvements) {
        console.log(chalk.green(`    ✓ ${r.serverName} › ${r.suiteName} › ${r.testName}`));
      }
      console.log();
    }

    // New tests
    if (result.newTests.length > 0) {
      console.log(chalk.cyan(`  New Tests (${result.newTests.length}):`));
      for (const r of result.newTests) {
        console.log(chalk.cyan(`    + ${r.serverName} › ${r.suiteName} › ${r.testName}`));
      }
      console.log();
    }

    // Removed tests
    if (result.removedTests.length > 0) {
      console.log(chalk.dim(`  Removed Tests (${result.removedTests.length}):`));
      for (const r of result.removedTests) {
        console.log(chalk.dim(`    - ${r.serverName} › ${r.suiteName} › ${r.testName}`));
      }
      console.log();
    }

    // Summary
    const hasRegressions = result.regressions.length > 0;
    console.log(chalk.dim('  Summary:'));
    console.log(`    Regressions: ${result.regressions.length}`);
    console.log(`    Improvements: ${result.improvements.length}`);
    console.log(`    New: ${result.newTests.length}`);
    console.log(`    Removed: ${result.removedTests.length}`);
    console.log();

    if (hasRegressions) {
      console.log(chalk.red('  ✗ Regressions detected — failing CI gate\n'));
      process.exit(1);
    } else {
      console.log(chalk.green('  ✓ No regressions detected\n'));
      process.exit(0);
    }
  } catch (err) {
    console.error(chalk.red(`\n  Error: ${(err as Error).message}\n`));
    process.exit(1);
  }
}
