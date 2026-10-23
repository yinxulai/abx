#!/usr/bin/env node
/**
 * Validate a commit message against the abx standard template.
 *
 * Usage:
 *   node packages/toolkit/scripts/check-commit-msg.mjs <path-to-message-file>
 *   pnpm commit:check .git/COMMIT_EDITMSG
 *
 * Wired into git via .githooks/commit-msg (installed by the `prepare` script).
 * Template: .gitmessage   Rules: AGENTS.md ("提交纪律")
 */
import { readFileSync } from 'node:fs'

const TYPES = [
  'feat',
  'fix',
  'refactor',
  'perf',
  'test',
  'docs',
  'build',
  'ci',
  'chore',
  'style',
  'revert',
]

const SUBJECT_RE = new RegExp(
  `^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._-]*\\))?!?: [a-z][^\\n]{0,71}$`,
)

// CJK ideographs, punctuation and fullwidth forms.
const CJK_RE =
  /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/

const REQUIRED_SECTIONS = ['Why', 'What']
const EXPECTED_SECTIONS = ['Verify']

const messagePath = process.argv[2]
if (!messagePath) {
  console.error('usage: check-commit-msg.mjs <path-to-message-file>')
  process.exit(2)
}

let raw
try {
  raw = readFileSync(messagePath, 'utf8')
} catch (error) {
  console.error(`cannot read ${messagePath}: ${error.message}`)
  process.exit(2)
}

// git strips lines starting with '#' before the commit is created.
const lines = raw.split('\n').filter((line) => !line.startsWith('#'))
while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

if (lines.length === 0) {
  console.error('✖ empty commit message')
  process.exit(1)
}

const subject = lines[0]

// Machine-generated messages are exempt from the template.
if (/^(Merge |Revert "|fixup!|squash!)/.test(subject)) process.exit(0)

const errors = []
const warnings = []

const cjkLines = lines
  .map((line, index) => (CJK_RE.test(line) ? index + 1 : 0))
  .filter((n) => n > 0)
if (cjkLines.length > 0) {
  errors.push(
    `message must be English -- CJK characters on line(s) ${cjkLines.join(', ')}`,
  )
} else if (!SUBJECT_RE.test(subject)) {
  errors.push(
    `subject does not match "<type>(<scope>): <summary>"\n` +
      `     got: ${JSON.stringify(subject)}\n` +
      `     allowed types: ${TYPES.join(' | ')}\n` +
      `     rules: imperative, lowercase summary, no trailing period, 72 chars max`,
  )
}

if (lines.length < 2 || lines[1].trim() !== '') {
  warnings.push('put a blank line between the subject and the body')
}

const sections = new Map()
let currentSection = null
for (const line of lines.slice(1)) {
  const header = /^([A-Z][A-Za-z]*):\s*(.*)$/.exec(line)
  if (header) {
    currentSection = header[1]
    sections.set(currentSection, header[2].trim() ? [header[2].trim()] : [])
    continue
  }
  if (currentSection && line.trim() !== '') {
    sections.get(currentSection).push(line.trim())
  }
}

for (const name of REQUIRED_SECTIONS) {
  if (!sections.has(name)) {
    errors.push(`missing "${name}:" section -- see .gitmessage`)
  } else if (sections.get(name).length === 0) {
    errors.push(`"${name}:" section is empty`)
  }
}

for (const name of EXPECTED_SECTIONS) {
  if (!sections.has(name)) {
    warnings.push(`no "${name}:" section -- record the command you ran and its result`)
  }
}

for (const line of lines) {
  if (line.length > 100) {
    warnings.push('wrap body lines at 100 characters')
    break
  }
}

for (const warning of warnings) console.error(`⚠ ${warning}`)

if (errors.length > 0) {
  console.error('')
  console.error('✖ commit message rejected:')
  for (const error of errors) console.error(`  - ${error}`)
  console.error('')
  console.error('  Template:  .gitmessage')
  console.error('  Rules:     AGENTS.md ("提交纪律")')
  console.error('  Bypass it: git commit --no-verify   (use sparingly)')
  process.exit(1)
}

process.exit(0)
