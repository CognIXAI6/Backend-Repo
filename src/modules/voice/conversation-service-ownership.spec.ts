/**
 * Static guard: a conversation id alone must never grant access. Every public
 * ConversationService method that takes a conversation (a `conversationId`
 * parameter, or a DTO/input type carrying one) must also take the caller's
 * `userId` — as a parameter or as a field of that DTO/input — so ownership is
 * enforced inside the query. A new method that forgets fails here.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

const FILE = path.resolve(__dirname, 'services/conversation.service.ts');

/** Methods whose conversation is created/found from the user id itself, not looked up by a given id. */
const NOT_LOOKUPS = new Set<string>([]);

describe('ConversationService ownership (static)', () => {
  const text = fs.readFileSync(FILE, 'utf8');
  const sf = ts.createSourceFile(FILE, text, ts.ScriptTarget.Latest, true);

  const interfaces = new Map<string, string>();
  sf.forEachChild((n) => {
    if (ts.isInterfaceDeclaration(n)) interfaces.set(n.name.text, n.getText(sf));
  });

  const typeText = (p: ts.ParameterDeclaration): string => {
    const t = p.type?.getText(sf) ?? '';
    const named = t.match(/^[A-Za-z_]\w*/)?.[0];
    return `${t} ${named ? interfaces.get(named) ?? '' : ''}`;
  };

  const publicMethods = (): ts.MethodDeclaration[] => {
    const out: ts.MethodDeclaration[] = [];
    sf.forEachChild((n) => {
      if (ts.isClassDeclaration(n) && n.name?.text === 'ConversationService') {
        for (const m of n.members) {
          if (!ts.isMethodDeclaration(m)) continue;
          if ((ts.getCombinedModifierFlags(m) & ts.ModifierFlags.Private) !== 0) continue;
          out.push(m);
        }
      }
    });
    return out;
  };

  it('finds the service and its methods (the guard is not vacuous)', () => {
    expect(publicMethods().length).toBeGreaterThan(30);
  });

  it('every method that takes a conversation also takes the caller\'s userId', () => {
    const missing: string[] = [];
    for (const m of publicMethods()) {
      const name = m.name.getText(sf);
      if (NOT_LOOKUPS.has(name)) continue;
      const params = m.parameters;
      const touchesConversation = params.some((p) => p.name.getText(sf) === 'conversationId' || /conversationId/.test(typeText(p)));
      if (!touchesConversation) continue;
      const hasUser = params.some((p) => p.name.getText(sf) === 'userId' || /\buserId\b/.test(typeText(p)));
      if (!hasUser) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it('the scan really sees both parameter forms (positional userId and a userId field on a DTO)', () => {
    const byName = new Map(publicMethods().map((m) => [m.name.getText(sf), m]));
    const positional = byName.get('getConversationFieldId')!;
    expect(positional.parameters.map((p) => p.name.getText(sf))).toEqual(['conversationId', 'userId']);
    const dtoBased = byName.get('saveMessage')!;
    expect(typeText(dtoBased.parameters[0])).toMatch(/userId/);
  });
});
