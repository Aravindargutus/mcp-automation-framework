/**
 * API: Compare two runs.
 *
 * GET /api/runs/compare?old=<runId>&new=<runId>
 * Returns regressions, improvements, grade changes.
 */
import { NextResponse } from 'next/server';
import { getRun } from '@/lib/run-store';

interface CompareResult {
  regressions: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  improvements: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  newTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  removedTests: Array<{ testId: string; testName: string; suiteName: string; serverName: string }>;
  gradeChanges: Array<{ serverName: string; oldGrade: string; newGrade: string; oldPct: number; newPct: number }>;
  oldRunId: string;
  newRunId: string;
  oldTimestamp: string;
  newTimestamp: string;
}

function extractTestMap(report: any): Map<string, { status: string; testName: string; suiteName: string; serverName: string }> {
  const map = new Map();
  for (const server of report.servers ?? []) {
    for (const suite of server.suites ?? []) {
      for (const test of suite.tests ?? []) {
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

export async function GET(request: Request) {
  const url = new URL(request.url);
  const oldRunId = url.searchParams.get('old');
  const newRunId = url.searchParams.get('new');

  if (!oldRunId || !newRunId) {
    return NextResponse.json({ error: 'Missing old or new runId params' }, { status: 400 });
  }

  const oldRun = getRun(oldRunId);
  const newRun = getRun(newRunId);

  if (!oldRun?.report || !newRun?.report) {
    return NextResponse.json({ error: 'One or both runs not found or not completed' }, { status: 404 });
  }

  const oldMap = extractTestMap(oldRun.report);
  const newMap = extractTestMap(newRun.report);

  const result: CompareResult = {
    regressions: [],
    improvements: [],
    newTests: [],
    removedTests: [],
    gradeChanges: [],
    oldRunId,
    newRunId,
    oldTimestamp: oldRun.report.timestamp ?? '',
    newTimestamp: newRun.report.timestamp ?? '',
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
  for (const newServer of (newRun.report.servers ?? []) as any[]) {
    const oldServer = ((oldRun.report.servers ?? []) as any[]).find((s: any) => s.serverName === newServer.serverName);
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

  return NextResponse.json(result);
}
