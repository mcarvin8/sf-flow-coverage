import { describe, expect, it } from 'vitest';

import { flowElementLines } from '../../src/core/flowElementLines.js';

describe('flowElementLines', () => {
  it('finds the name line of each executable element, in file order', () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>', // 1
      '<Flow xmlns="http://soap.sforce.com/2006/04/metadata">', // 2
      '    <assignments>', // 3
      '        <name>Set_Status</name>', // 4
      '    </assignments>', // 5
      '    <!-- <decisions><name>Commented_Out</name></decisions> -->', // 6
      '    <decisions>', // 7
      '        <description><![CDATA[Uses <name>Not_A_Name</name> in text]]></description>', // 8
      '        <rules>', // 9
      '            <name>Rule_Name</name>', // 10
      '        </rules>', // 11
      '        <name>Is_Open</name>', // 12
      '    </decisions>', // 13
      '    <variables>', // 14
      '        <name>recordId</name>', // 15
      '    </variables>', // 16
      '    <recordUpdates><connector/><name>Save</name></recordUpdates>', // 17
      '    <customErrors>', // 18
      '        <label>No name</label>', // 19
      '    </customErrors>', // 20
      '    <loops><name/></loops>', // 21
      '    <start>', // 22
      '        <name>Not_An_Element</name>', // 23
      '    </start>', // 24
      '</Flow>', // 25
    ].join('\n');
    expect(flowElementLines(xml)).toEqual([
      { name: 'Set_Status', type: 'assignment', line: 4 },
      { name: 'Is_Open', type: 'decision', line: 12 },
      { name: 'Save', type: 'recordUpdate', line: 17 },
    ]);
  });

  it('handles Windows line endings and a name without a closing tag', () => {
    expect(flowElementLines('<Flow>\r\n<subflows>\r\n<name>Call_It</name>\r\n</subflows>\r\n</Flow>')).toEqual([
      { name: 'Call_It', type: 'subflow', line: 3 },
    ]);
    expect(flowElementLines('<Flow><waits><name>Pause')).toEqual([]);
  });
});
