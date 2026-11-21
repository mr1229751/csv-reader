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
// Where csv-reader builds each field a character at a time, this reader cuts fields out of
// the text with slice: a record on one line holding no quote and no stray CR is split at its
// commas in one go, a quoted field is closed by jumping to the next quote with indexOf, and
// only the characters of a field that drops or rewrites something are walked one by one.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// What an unquoted scan stops for, by char code: 1 = LF, 2 = CR, 3 = comma; every other
// code (and every code past the table) is an ordinary character of the field.
const SPECIAL = new Uint8Array(64);
SPECIAL[10] = 1;
SPECIAL[13] = 2;
SPECIAL[44] = 3;

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
  // The first LF at or after the record being read started (its index, or -1 when the rest
  // of the text holds none): a quoted field that closes before it holds no line break.
  let recNl = -1;

  // Reads unquoted characters onto `value` up to the next comma or line break, csv-reader's
  // readUnquoted: a CR not followed by LF is dropped (stray_cr). Used off the hot path: for
  // the junk after a closing quote and for re-reading an unterminated quote's text.
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
    // The field may have spanned lines: the record's first LF is found afresh from here.
    recNl = text.indexOf('\n', pos);
    return afterClose(value);
  }

  // Reads the quoted field whose opening quote is at pos: jumps from quote to quote with
  // indexOf, and walks the field a character at a time only when a stretch of it holds a
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
      // or before recNl (the record's first), and a CR is looked for on the slice itself.
      if ((recNl !== -1 && q >= recNl) || segStr.indexOf('\r') !== -1) {
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

    // Fast path: a record that sits on one line and holds no quote and no stray CR is read
    // by splitting its line at the commas. (The line's slice bounds every search: a quote or
    // a CR anywhere in it sends the record to the general path below.)
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? len : nl;
    let contentEnd = lineEnd;
    if (nl !== -1 && lineEnd > pos && text.charCodeAt(lineEnd - 1) === 13) contentEnd = lineEnd - 1;
    const lineStr = text.slice(pos, contentEnd);
    if (lineStr.indexOf('"') === -1 && lineStr.indexOf('\r') === -1) {
      const fields = lineStr.split(',');
      pos = nl === -1 ? len : nl + 1;
      line += 1;
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
      continue;
    }

    // General path: field by field.
    recNl = nl;
    const fields = [];
    let quoted = false;
    let ended = END;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        fields.push(readQuoted());
        ended = fEnded;
      } else {
        quoted = false;
        const start = pos;
        let seg = pos;
        let parts = null;
        ended = END;
        let fEnd = pos;
        while (pos < len) {
          const fc = text.charCodeAt(pos);
          const sp = SPECIAL[fc];
          if (sp === undefined || sp === 0) {
            pos += 1;
            continue;
          }
          if (sp === 3) { // ,
            fEnd = pos;
            pos += 1;
            ended = COMMA;
            break;
          }
          if (sp === 1) { // LF
            fEnd = pos;
            pos += 1;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          // CR
          if (text.charCodeAt(pos + 1) === 10) {
            fEnd = pos;
            pos += 2;
            line += 1;
            ended = LINE_BREAK;
            break;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          if (parts === null) parts = [];
          parts.push(text.slice(seg, pos));
          pos += 1;
          seg = pos;
        }
        if (ended === END) fEnd = pos;
        if (parts === null) {
          fields.push(text.slice(start, fEnd));
        } else {
          parts.push(text.slice(seg, fEnd));
          fields.push(parts.join(''));
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
