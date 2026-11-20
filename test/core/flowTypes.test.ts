import { describe, expect, it } from 'vitest';

import { flowNameFromPath, isCountedProcessType, qualifiedFlowName, splitFlowName } from '../../src/core/flowTypes.js';

describe('flowTypes', () => {
  it('counts autolaunched Flows and processes, case-insensitively', () => {
    expect(isCountedProcessType('AutoLaunchedFlow')).toBe(true);
    expect(isCountedProcessType('AutolaunchedFlow')).toBe(true);
    expect(isCountedProcessType('Workflow')).toBe(true);
    expect(isCountedProcessType('CustomEvent')).toBe(true);
    expect(isCountedProcessType('InvocableProcess')).toBe(true);
  });

  it('does not count screen Flows or missing types', () => {
    expect(isCountedProcessType('Flow')).toBe(false);
    expect(isCountedProcessType(undefined)).toBe(false);
    expect(isCountedProcessType('')).toBe(false);
  });

  it('qualifies and splits namespaced names', () => {
    expect(qualifiedFlowName('My_Flow', 'acme')).toBe('acme__My_Flow');
    expect(qualifiedFlowName('My_Flow', null)).toBe('My_Flow');
    expect(splitFlowName('acme__My_Flow')).toEqual({ namespacePrefix: 'acme', developerName: 'My_Flow' });
    expect(splitFlowName('My_Flow')).toEqual({ developerName: 'My_Flow' });
    expect(splitFlowName('__Odd')).toEqual({ developerName: '__Odd' });
  });

  it('reads Flow names from source and metadata format paths', () => {
    expect(flowNameFromPath('force-app/main/default/flows/My_Flow.flow-meta.xml')).toBe('My_Flow');
    expect(flowNameFromPath('src\\flows\\My_Flow.flow')).toBe('My_Flow');
    expect(flowNameFromPath('My_Flow.flow-meta.xml')).toBe('My_Flow');
    expect(flowNameFromPath('force-app/classes/My.cls')).toBeUndefined();
    expect(flowNameFromPath('flows/My_Flow.flowDefinition-meta.xml')).toBeUndefined();
  });
});
