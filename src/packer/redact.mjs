const secrets = /-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?-----END \1-----|\b(Bearer\s+)[A-Za-z0-9._~+/=-]+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[\w-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b|((?:[A-Za-z0-9_]*api[_-]?key|access[_-]?token|client[_-]?secret)["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+\/=:-]{6,}/gi

export function redact(text) {
  let redactedCount = 0
  const clean = text.replace(secrets, (match, _pem, bearer, prefix) => {
    redactedCount++
    return (bearer ?? prefix ?? '') + '[REDACTED]'
  })
  return { clean, redactedCount }
}

// Redact string values before JSON escaping changes quotes and line breaks in user text.
export function redactJson(value, space) {
  let redactedCount = 0
  const clean = JSON.stringify(value, (key, field) => {
    if (typeof field !== 'string') return field
    if (/(?:api[_-]?key|access[_-]?token|client[_-]?secret)$/i.test(key) && field && field !== '[REDACTED]') {
      redactedCount++
      return '[REDACTED]'
    }
    const masked = redact(field)
    redactedCount += masked.redactedCount
    return masked.clean
  }, space)
  return { clean, redactedCount }
}

export function cleanLines(rows) {
  let redactedCount = 0
  const lines = rows.map(row => {
    const masked = redactJson(row)
    redactedCount += masked.redactedCount
    return masked.clean
  })
  return { clean: lines.join('\n') + '\n', redactedCount }
}
