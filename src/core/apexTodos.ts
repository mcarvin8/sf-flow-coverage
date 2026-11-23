import type { ApexTodo } from './types.js';

const METHOD = /^\s+(?:@IsTest\s+)?(?:private\s+)?static\s+\w+\s+(\w+)\(\)\s*\{$/;
const COMMENT_TODO = /\/\/\s*TODO:\s*(.+)$/;
const BLOCK_TODO = /\/\*\s*TODO:\s*(.+?)\s*\*\//;
const HEADER_TODO = /^\s*\*\s*TODO:\s*(.+)$/;
const HEADER_LINE = /^\s*\*\s+(\S.*)$/;
/** A kind at the start of a TODO, such as `validation rule: Needs_Parent`. */
const KIND = /^([a-z][a-z ]*[a-z]): /;

function todo(text: string, method?: string): ApexTodo {
  const kind = KIND.exec(text)?.[1];
  return {
    ...(method ? { method } : {}),
    ...(kind ? { kind } : {}),
    text,
  };
}

/**
 * The TODOs in a generated test class, in order: line comments (`// TODO: ...`), inline ones in
 * field values (`null /* TODO: ... *\/`), and the class header's, whose lines are joined. Each
 * names the test method it's in, if any, and its kind when the text starts with one.
 */
export function apexTodos(body: string): ApexTodo[] {
  const todos: ApexTodo[] = [];
  let method: string | undefined;
  let header: string[] | undefined;
  const closeHeader = (): void => {
    if (header) todos.push(todo(header.join(' ')));
    header = undefined;
  };
  for (const line of body.split('\n')) {
    const start = METHOD.exec(line);
    if (start) method = start[1];
    if (header) {
      const more = HEADER_LINE.exec(line);
      if (more && !HEADER_TODO.test(line)) {
        header.push(more[1]);
        continue;
      }
      closeHeader();
    }
    const heading = HEADER_TODO.exec(line);
    if (heading) {
      header = [heading[1]];
      continue;
    }
    const comment = COMMENT_TODO.exec(line) ?? BLOCK_TODO.exec(line);
    if (comment) todos.push(todo(comment[1].trim(), method));
  }
  closeHeader();
  return todos;
}
