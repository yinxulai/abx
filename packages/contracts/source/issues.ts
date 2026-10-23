/**
 * 配置校验的报错形状。
 *
 * 一次收集全部问题再报，而不是遇到第一个就抛：配置是人手写的，改一处跑一次、
 * 每次只被告知一个错，是最消耗耐心的那种体验。
 */

export interface ConfigIssue {
  /** 出问题的位置，例如 `upstreams[0].baseUrl`。 */
  readonly path: string
  readonly message: string
}

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[]

  constructor(issues: readonly ConfigIssue[]) {
    super(renderIssues(issues))
    this.name = 'ConfigError'
    this.issues = issues
  }
}

export function renderIssues(issues: readonly ConfigIssue[]): string {
  const lines = issues.map((issue) => `  - ${issue.path === '' ? '<root>' : issue.path}: ${issue.message}`)
  return [`配置有 ${issues.length} 处问题：`, ...lines].join('\n')
}

/** 收集器：读取器往这里塞问题，最后一次性拿出来。 */
export class IssueCollector {
  readonly #issues: ConfigIssue[] = []

  add(path: string, message: string): void {
    this.#issues.push({ path, message })
  }

  get issues(): readonly ConfigIssue[] {
    return this.#issues
  }

  get ok(): boolean {
    return this.#issues.length === 0
  }
}
