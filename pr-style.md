Fixes the em dashes in the bot's own reviews.

## The problem

The bot writes in em dashes, and it does it the way models do: as a stand-in for
punctuation the writer did not feel like choosing. Half the sentences in a review
read like a form letter.

## Why not just tell the model

Because asking nicely is not a guarantee, and this is the same model that
produced a review eight-tenths wrong last week. So the prompt asks, and
`src/style.js` makes it true.

The rewrite sits in the parse layer, which is the one place all three of the
summary, every comment body and every thread reply pass through. Nothing has to
remember to call it, and a new call site cannot forget.

## What a dash becomes

Two replacements and no more:

- a **comma** when the dash sat between two clause halves
- a **space** when the text on the left had already ended in a full stop

An earlier version tried to tell a colon from a semicolon from parentheses, and
it put colons in the middle of ordinary sentences often enough to read as a
bug. So it is gone. A comma and a space are the two replacements that stay
grammatical wherever a dash can turn up in prose.

| Input | Output |
| --- | --- |
| `This is a bug — the loop breaks early.` | `This is a bug, the loop breaks early.` |
| `The value — which is null here — is checked.` | `The value, which is null here, is checked.` |
| `already ended. — Next sentence.` | `already ended. Next sentence.` |
| `An aside (like this — really) closes.` | `An aside (like this really) closes.` |

## Left alone

Hyphens, number ranges, negative numbers, command flags, list bullets, table
pipes, and anything inside a code span, fenced block, link target or HTML
comment. So `--dry-run`, `5-10`, `-1`, `well-known` and ``` `a — b` ``` all
survive untouched.

A dash the module cannot classify is left as it is. A mangled review is worse
than a dashed one.

## Three bugs found by testing the output instead of trusting it

Worth recording, because all three produced text that looked fine in code and
was wrong on the page:

1. Text was joined twice over. The copy cursor was not told that the replacement
   had already supplied its own trailing space.
2. Every join came out with a doubled space, same root cause.
3. A comma landing before a newline left trailing whitespace at the end of a
   line. Layout wins over punctuation there.

## Tests

69 pass, 13 new. The style tests assert that no word is lost or duplicated by a
rewrite, not just that the dash is gone, since a rewrite that quietly changes
the sentence would be worse than the dash it replaced.

No repo or language is named in any of it. The bot reviews whatever it is
pointed at, so nothing here could depend on the repository it happens to be
looking at.
