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
// Where csv-reader builds each field a character at a time, this reader scans to the next
// character that matters and cuts the field out of the text with slice, splitting a field
// into pieces only where the policy drops or rewrites a character.

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

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not
  // followed by LF is dropped (stray_cr). Returns [value, ended, added], added counting the
  // characters kept from the text.
  function readUnquoted(value) {
    const start = pos;
    let seg = pos;
    let parts = null;
    let added = 0;
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 44) { // ,
        pos += 1;
        if (parts === null) return [value + text.slice(start, pos - 1), COMMA, pos - 1 - start];
        parts.push(text.slice(seg, pos - 1));
        return [parts.join(''), COMMA, added + pos - 1 - seg];
      }
      if (c === 10) { // LF
        pos += 1;
        line += 1;
        if (parts === null) return [value + text.slice(start, pos - 1), LINE_BREAK, pos - 1 - start];
        parts.push(text.slice(seg, pos - 1));
        return [parts.join(''), LINE_BREAK, added + pos - 1 - seg];
      }
      if (c === 13) { // CR
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          if (parts === null) return [value + text.slice(start, pos - 2), LINE_BREAK, pos - 2 - start];
          parts.push(text.slice(seg, pos - 2));
          return [parts.join(''), LINE_BREAK, added + pos - 2 - seg];
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
    if (parts === null) return [value + text.slice(start, pos), END, pos - start];
    parts.push(text.slice(seg, pos));
    return [parts.join(''), END, added + pos - seg];
  }

  // Reads a quoted field whose opening quote is at pos. Returns [value, ended, added].
  function readQuoted() {
    const open = pos;
    const openLine = line;
    pos += 1;
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
      return readUnquoted('"');
    }
    let value;
    if (parts === null) {
      value = text.slice(seg, pos - 1);
    } else {
      parts.push(text.slice(seg, pos - 1));
      value = parts.join('');
    }
    if (pos >= len) return [value, END, 0];
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return [value, COMMA, 0];
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return [value, LINE_BREAK, 0];
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    const junk = readUnquoted(value);
    if (junk[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted = false;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field[0]);
    } while (field[1] === COMMA);

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
