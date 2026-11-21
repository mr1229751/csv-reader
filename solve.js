// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's answer
// {columns, rows, errors} for every input {text, header}.
//
// The reading is csv-reader's own, one pass left to right with its broken-row policy:
// a U+FEFF at the start is dropped; records end at LF or CRLF and empty lines are no records;
// a CR outside quotes not followed by LF is dropped (stray_cr); a field that opens with a
// quote runs to the next non-doubled quote ("" is one quote, CRLF or a lone CR inside reads
// as LF), junk after the closing quote is appended as it stands (quote_junk), and a quote
// that never closes is a literal character whose text is re-read as unquoted
// (unterminated_quote); rows are padded (short_row) or cut (long_row) to the first record's
// width; every error is {code, line, row} in the order met.
//
// Where csv-reader walks the text a character at a time, this reader jumps: an unquoted
// field is found with indexOf (the next comma, bounded by the end of its line) and cut out
// with slice, a quoted field is closed by jumping from quote to quote, and a whole line is
// checked for a CR once, on its slice, instead of once per character. The character-at-a-
// time walk remains only where the policy drops or rewrites a character: inside a field
// that holds a line break, after a closing quote, and on the rare line that holds a CR.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // How the last field a helper read ended, and how many characters it kept (for quote_junk).
  let fEnded = END;
  let fAdded = 0;

  // The line the reader is on: lineLim is the index of its LF (or len when the rest of the
  // text holds none), lineCend the index its content ends at (before a CRLF's CR), and
  // lineHasCr whether that content holds a CR. A quoted field that closes before lineLim
  // holds no line break.
  let lineLim = len;
  let lineCend = len;
  let lineHasCr = false;

  // Finds the line holding pos: its LF, its content end, and whether its content holds a CR.
  function syncLine() {
    const nl = text.indexOf('\n', pos);
    lineLim = nl === -1 ? len : nl;
    lineCend = lineLim < len ? (text.charCodeAt(lineLim - 1) === 13 ? lineLim - 1 : lineLim) : len;
    lineHasCr = text.slice(pos, lineCend).indexOf('\r') !== -1;
  }

  // Reads unquoted characters onto `value` up to the next comma or line break, csv-reader's
  // readUnquoted: a CR not followed by LF is dropped (stray_cr). Used where a character at
  // a time is required: for the junk after a closing quote, for re-reading an unterminated
  // quote's text, and for a field on a line that holds a CR.
  function scanTail(value) {
    const start = pos;
    let seg = pos;
    let parts = null;
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        pos += 1;
        fEnded = COMMA;
        if (parts === null) {
          fAdded = pos - 1 - start;
          return value + text.slice(start, pos - 1);
        }
        parts.push(text.slice(seg, pos - 1));
        fAdded = added + pos - 1 - seg;
        return parts.join('');
      }
      if (c === 10) { // LF
        pos += 1;
        line += 1;
        fEnded = LINE_BREAK;
        if (parts === null) {
          fAdded = pos - 1 - start;
          return value + text.slice(start, pos - 1);
        }
        parts.push(text.slice(seg, pos - 1));
        fAdded = added + pos - 1 - seg;
        return parts.join('');
      }
      if (c === 13) { // CR
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          fEnded = LINE_BREAK;
          if (parts === null) {
            fAdded = pos - 2 - start;
            return value + text.slice(start, pos - 2);
          }
          parts.push(text.slice(seg, pos - 2));
          fAdded = added + pos - 2 - seg;
          return parts.join('');
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (parts === null) {
          parts = [];
          if (value !== '') parts.push(value);
        }
        parts.push(text.slice(seg, pos));
        added += pos - seg;
        pos += 1;
        seg = pos;
        continue;
      }
      pos += 1;
    }
    fEnded = END;
    if (parts === null) {
      fAdded = pos - start;
      return value + text.slice(start, pos);
    }
    parts.push(text.slice(seg, pos));
    fAdded = added + pos - seg;
    return parts.join('');
  }

  // What follows a quoted field's closing quote (pos is just past it): the field ends here,
  // or what follows is appended as it stands (quote_junk, when it keeps a character).
  function afterClose(value) {
    if (pos >= len) {
      fEnded = END;
      return value;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fEnded = COMMA;
      return value;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fEnded = LINE_BREAK;
      return value;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fEnded = LINE_BREAK;
      return value;
    }
    const junk = scanTail(value);
    if (fAdded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Reads a quoted field a character at a time (its opening quote is at `open`): the general
  // path, for fields whose text holds a line break or a rewritten character.
  function readQuotedSlow(open, openLine) {
    pos = open + 1;
    line = openLine;
    let seg = pos;
    let parts = null;
    let closed = false;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 34) { // "
        if (text.charCodeAt(pos + 1) === 34) {
          if (parts === null) parts = [];
          parts.push(text.slice(seg, pos), '"');
          pos += 2;
          seg = pos;
          continue;
        }
        pos += 1;
        closed = true;
        break;
      }
      if (c === 13) { // CRLF and a lone CR inside quotes are each one LF
        if (parts === null) parts = [];
        parts.push(text.slice(seg, pos), '\n');
        line += 1;
        pos += text.charCodeAt(pos + 1) === 10 ? 2 : 1;
        seg = pos;
        continue;
      }
      if (c === 10) line += 1;
      pos += 1;
    }
    if (!closed) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return scanTail('"');
    }
    let value;
    if (parts === null) {
      value = text.slice(seg, pos - 1);
    } else {
      parts.push(text.slice(seg, pos - 1));
      value = parts.join('');
    }
    return afterClose(value);
  }

  // Reads the quoted field whose opening quote is at pos: jumps from quote to quote with
  // indexOf, and walks the field a character at a time only when a stretch of it may hold a
  // line break (the stretches between quotes are checked on their slice, so the search
  // never runs past the stretch).
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let seg = open + 1;
    let scan = seg;
    let parts = null;
    while (true) {
      const q = text.indexOf('"', scan);
      if (q === -1) {
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return scanTail('"');
      }
      const segStr = text.slice(seg, q);
      // A stretch holding a line break is walked a character at a time: an LF would sit at
      // or before lineLim (the line's first), and a CR is looked for on the slice itself.
      if (q >= lineLim || segStr.indexOf('\r') !== -1) {
        return readQuotedSlow(open, openLine);
      }
      if (text.charCodeAt(q + 1) === 34) { // a doubled quote: one quote of the field
        if (parts === null) parts = [];
        parts.push(segStr, '"');
        seg = q + 2;
        scan = q + 2;
        continue;
      }
      pos = q + 1;
      const value = parts === null ? segStr : (parts.push(segStr), parts.join(''));
      return afterClose(value);
    }
  }

  while (true) {
    // Lines with no characters are no records.
    let c = text.charCodeAt(pos);
    if (c === 10 || (c === 13 && text.charCodeAt(pos + 1) === 10)) {
      do {
        if (c === 10) {
          pos += 1;
          line += 1;
        } else {
          pos += 2;
          line += 1;
        }
        c = text.charCodeAt(pos);
      } while (c === 10 || (c === 13 && text.charCodeAt(pos + 1) === 10));
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    syncLine();

    const fields = [];
    let quoted = false;
    let ended = END;
    do {
      if (pos > lineLim) syncLine(); // a quoted field spanned lines: find the line we are on
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(readQuoted());
        ended = fEnded;
      } else {
        quoted = false;
        if (lineHasCr) {
          fields.push(scanTail(''));
          ended = fEnded;
        } else {
          const comma = text.indexOf(',', pos);
          if (comma !== -1 && comma < lineCend) {
            fields.push(text.slice(pos, comma));
            pos = comma + 1;
            ended = COMMA;
          } else {
            fields.push(text.slice(pos, lineCend));
            if (lineLim < len) {
              pos = lineLim + 1;
              line += 1;
              ended = LINE_BREAK;
            } else {
              pos = len;
              ended = END;
            }
          }
        }
      }
    } while (ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
