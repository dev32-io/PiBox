const SENSITIVE_EVIDENCE_NAME = /(^|[._-])(env|credentials?|secrets?|private|token|password|passwd|api[-_]?key|transcript|session)([._-]|$)|\.(pem|key|p12|pfx)$/i;
const SENSITIVE_EVIDENCE_CONTENT = /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:["']?(?:api[_-]?key|access[_-]?token|secret|password|passwd)["']?\s*[:=]\s*(?:["'][^"'\r\n]+["']|[^\s,}\]]+))|(?:["']?authorization["']?\s*[:=]\s*["']?bearer\s+[a-z0-9._~+/=-]+))/i;

export function looksSensitiveEvidenceName(name: string): boolean {
	return SENSITIVE_EVIDENCE_NAME.test(name);
}

export function containsObviousSensitiveContent(content: string): boolean {
	return SENSITIVE_EVIDENCE_CONTENT.test(content);
}
