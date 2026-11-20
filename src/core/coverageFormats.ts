import type { FlowFileCoverage } from './transform.js';

export const COVERAGE_FORMATS = ['sonar', 'cobertura', 'lcov'] as const;

export type CoverageFormat = (typeof COVERAGE_FORMATS)[number];

/** File name written for each format. */
export const COVERAGE_FILE_NAMES: Record<CoverageFormat, string> = {
  sonar: 'flow-coverage-sonar.xml',
  cobertura: 'flow-coverage-cobertura.xml',
  lcov: 'flow-coverage.info',
};

const escapeXml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const coveredCount = (file: FlowFileCoverage): number => file.lines.filter((l) => l.covered).length;

/** Line rate as Cobertura writes it: 0 to 1, four decimals. */
const rate = (covered: number, total: number): string => (total === 0 ? '1' : (covered / total).toFixed(4));

/** SonarQube generic test coverage (`sonar.coverageReportPaths`). */
function toSonar(files: FlowFileCoverage[]): string {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<coverage version="1">'];
  for (const file of files) {
    lines.push(`  <file path="${escapeXml(file.path)}">`);
    for (const line of file.lines) {
      lines.push(`    <lineToCover lineNumber="${line.line}" covered="${line.covered}"/>`);
    }
    lines.push('  </file>');
  }
  lines.push('</coverage>', '');
  return lines.join('\n');
}

/** Cobertura XML, one package per folder and one class per Flow. */
function toCobertura(files: FlowFileCoverage[], now: Date): string {
  const total = files.reduce((sum, f) => sum + f.lines.length, 0);
  const covered = files.reduce((sum, f) => sum + coveredCount(f), 0);
  const packages = new Map<string, FlowFileCoverage[]>();
  for (const file of files) {
    const folder = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
    packages.set(folder, [...(packages.get(folder) ?? []), file]);
  }
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE coverage SYSTEM "http://cobertura.sourceforge.net/xml/coverage-04.dtd">',
    `<coverage line-rate="${rate(covered, total)}" branch-rate="0" lines-covered="${covered}" lines-valid="${total}" branches-covered="0" branches-valid="0" complexity="0" version="1" timestamp="${now.getTime()}">`,
    '  <sources>',
    '    <source>.</source>',
    '  </sources>',
    '  <packages>',
  ];
  for (const [folder, members] of packages) {
    const packageTotal = members.reduce((sum, f) => sum + f.lines.length, 0);
    const packageCovered = members.reduce((sum, f) => sum + coveredCount(f), 0);
    lines.push(
      `    <package name="${escapeXml(folder.replace(/\//g, '.'))}" line-rate="${rate(packageCovered, packageTotal)}" branch-rate="0" complexity="0">`,
      '      <classes>',
    );
    for (const file of members) {
      lines.push(
        `        <class name="${escapeXml(file.flowName)}" filename="${escapeXml(file.path)}" line-rate="${rate(coveredCount(file), file.lines.length)}" branch-rate="0" complexity="0">`,
        '          <methods/>',
        '          <lines>',
        ...file.lines.map((l) => `            <line number="${l.line}" hits="${l.covered ? 1 : 0}" branch="false"/>`),
        '          </lines>',
        '        </class>',
      );
    }
    lines.push('      </classes>', '    </package>');
  }
  lines.push('  </packages>', '</coverage>', '');
  return lines.join('\n');
}

/** lcov tracefile. */
function toLcov(files: FlowFileCoverage[]): string {
  const lines: string[] = [];
  for (const file of files) {
    lines.push('TN:', `SF:${file.path}`);
    for (const line of file.lines) lines.push(`DA:${line.line},${line.covered ? 1 : 0}`);
    lines.push(`LF:${file.lines.length}`, `LH:${coveredCount(file)}`, 'end_of_record');
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/** Writes Flow element coverage in a format other coverage tools read. */
export function formatCoverage(format: CoverageFormat, files: FlowFileCoverage[], now: Date = new Date()): string {
  switch (format) {
    case 'sonar':
      return toSonar(files);
    case 'cobertura':
      return toCobertura(files, now);
    default:
      return toLcov(files);
  }
}
