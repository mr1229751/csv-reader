// Exact csv-reader semantics with native searches and no per-field objects.
// State and regular-expression cursors are private to each call.
export function run(input) {
  const text = String(input.text), n = text.length;
  const header = input.header === true;
  const rows = [], errors = [];
  const delimiter = /[,\r\n]/g, hasNewline = /[\r\n]/;
  let columns = null, width = -1;
  let p = text.charCodeAt(0) === 0xfeff ? 1 : 0, line = 1;
  while (p < n) {
    const first = text.charCodeAt(p);
    if (first === 10) { p++; line++; continue; }
    if (first === 13 && text.charCodeAt(p+1) === 10) { p+=2; line++; continue; }
    const recordLine = line, recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let more = true, wasQuoted = false;
    while (more) {
      wasQuoted = text.charCodeAt(p) === 34;
      let value = '', junk = false;
      if (wasQuoted) {
        const open = p;
        let q = p+1, escaped = false;
        for (;;) {
          q = text.indexOf('"', q);
          if (q < 0) break;
          if (text.charCodeAt(q+1) !== 34) break;
          escaped = true; q+=2;
        }
        if (q < 0) {
          errors.push({code:'unterminated_quote', line:recordLine, row:recordRow});
          p = open+1; value = '"';
        } else {
          value = text.slice(open+1,q);
          if (escaped) value = value.replaceAll('""','"');
          if (hasNewline.test(value)) {
            line += value.match(/\r\n?|\n/g).length;
            value = value.replace(/\r\n?/g,'\n');
          }
          p = q+1; junk = true;
        }
      }
      let segment = p, added = 0;
      for (;;) {
        delimiter.lastIndex = p;
        const found = delimiter.test(text);
        const end = found ? delimiter.lastIndex-1 : n;
        value += text.slice(segment,end); added += end-segment;
        if (!found) { p=n; more=false; break; }
        const c = text.charCodeAt(end);
        p=end+1;
        if (c === 44) break;
        if (c === 10 || text.charCodeAt(p) === 10) {
          if (c === 13) p++;
          line++; more=false; break;
        }
        errors.push({code:'stray_cr', line:recordLine, row:recordRow});
        segment=p;
      }
      if (junk && added) errors.push({code:'quote_junk', line:recordLine, row:recordRow});
      fields.push(value);
    }
    if (fields.length === 1 && fields[0] === '' && !wasQuoted) continue;
    if (width < 0) width=fields.length;
    if (header && columns === null) { columns=fields; continue; }
    if (fields.length < width) {
      errors.push({code:'short_row',line:recordLine,row:recordRow,fields:fields.length});
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({code:'long_row',line:recordLine,row:recordRow,extra:fields.splice(width)});
    }
    rows.push(fields);
  }
  return {columns:header ? columns ?? [] : null, rows, errors};
}
