/**
 * T3o (T3O-134): a card thread's title as its session tab shows it. The supervisor names
 * threads `${card.key} · ${label}`, which repeats the card a phone has no room for; a title
 * the user renamed keeps every word.
 */
const SEPARATOR = " · ";

export function splitBoardThreadTabTitle(
  cardKey: string,
  title: string,
): { readonly prefix: string; readonly rest: string } {
  const prefix = `${cardKey}${SEPARATOR}`;
  if (cardKey.length === 0 || !title.startsWith(prefix) || title.length === prefix.length) {
    return { prefix: "", rest: title };
  }
  return { prefix, rest: title.slice(prefix.length) };
}
