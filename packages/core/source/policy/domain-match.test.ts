import { describe, expect, it } from 'vitest'
import { isSubdomainOf, matchesAnyPattern, matchesDomainPattern } from './domain-match'
import { isValidDomainPattern, normalizeHost, parseDomainPattern } from '@abx/contracts'

describe('normalizeHost', () => {
  it('小写化', () => {
    expect(normalizeHost('API.Example.COM')).toBe('api.example.com')
  })

  it('去掉端口', () => {
    expect(normalizeHost('api.example.com:443')).toBe('api.example.com')
    expect(normalizeHost('127.0.0.1:8788')).toBe('127.0.0.1')
  })

  it('去掉末尾的根标签点', () => {
    // 不去掉的话 `Host: api.example.com.` 就能绕过白名单。
    expect(normalizeHost('api.example.com.')).toBe('api.example.com')
    expect(normalizeHost('api.example.com.:443')).toBe('api.example.com')
  })

  it('IPv6 字面量剥掉方括号和端口', () => {
    expect(normalizeHost('[::1]:8788')).toBe('::1')
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1')
  })

  it('裸 IPv6 不会被当成端口切掉', () => {
    expect(normalizeHost('2001:db8::1')).toBe('2001:db8::1')
  })
})

describe('isSubdomainOf', () => {
  it('子域为真', () => {
    expect(isSubdomainOf('api.example.com', 'example.com')).toBe(true)
    expect(isSubdomainOf('a.b.example.com', 'example.com')).toBe(true)
  })

  it('自身不算子域', () => {
    expect(isSubdomainOf('example.com', 'example.com')).toBe(false)
  })

  it('前缀相似的域名不算子域', () => {
    // 少写一个点，`notexample.com` 就会变成 `example.com` 的子域。这是最经典的一个洞。
    expect(isSubdomainOf('notexample.com', 'example.com')).toBe(false)
    expect(isSubdomainOf('example.com.evil.com', 'example.com')).toBe(false)
  })
})

describe('matchesDomainPattern', () => {
  describe('精确域名', () => {
    it('只匹配自身', () => {
      expect(matchesDomainPattern('api.example.com', 'api.example.com')).toBe(true)
      expect(matchesDomainPattern('www.api.example.com', 'api.example.com')).toBe(false)
      expect(matchesDomainPattern('example.com', 'api.example.com')).toBe(false)
    })

    it('大小写与端口不影响命中', () => {
      expect(matchesDomainPattern('API.Example.com:443', 'api.example.com')).toBe(true)
    })
  })

  describe('*.example.com（含子域，不含自身）', () => {
    it('匹配任意层级的子域', () => {
      expect(matchesDomainPattern('api.example.com', '*.example.com')).toBe(true)
      expect(matchesDomainPattern('a.b.example.com', '*.example.com')).toBe(true)
    })

    it('不匹配裸域名自身', () => {
      expect(matchesDomainPattern('example.com', '*.example.com')).toBe(false)
    })

    it('不匹配前缀相似的域名', () => {
      expect(matchesDomainPattern('notexample.com', '*.example.com')).toBe(false)
      expect(matchesDomainPattern('example.com.evil.com', '*.example.com')).toBe(false)
      expect(matchesDomainPattern('example.com.attacker.net', '*.example.com')).toBe(false)
    })
  })

  describe('.example.com（含自身与子域）', () => {
    it('匹配自身', () => {
      expect(matchesDomainPattern('example.com', '.example.com')).toBe(true)
    })

    it('匹配子域', () => {
      expect(matchesDomainPattern('api.example.com', '.example.com')).toBe(true)
      expect(matchesDomainPattern('a.b.example.com', '.example.com')).toBe(true)
    })

    it('不匹配前缀相似或后缀相似的域名', () => {
      expect(matchesDomainPattern('notexample.com', '.example.com')).toBe(false)
      expect(matchesDomainPattern('example.com.evil.com', '.example.com')).toBe(false)
      expect(matchesDomainPattern('example.com.au', '.example.com')).toBe(false)
    })
  })

  describe('坏模式一律不匹配', () => {
    it('裸 * 不被当成通配', () => {
      // 配置校验会拒掉 `*`（见 load-config 的用例）；万一漏到运行时，
      // 这里也必须是不匹配，而不是匹配一切。
      expect(matchesDomainPattern('anything.example.com', '*')).toBe(false)
      expect(matchesDomainPattern('example.com', '*')).toBe(false)
    })

    it('带协议或路径的模式不匹配', () => {
      expect(matchesDomainPattern('api.example.com', 'https://api.example.com')).toBe(false)
      expect(matchesDomainPattern('api.example.com', 'api.example.com/v1')).toBe(false)
    })

    it('空模式不匹配', () => {
      expect(matchesDomainPattern('api.example.com', '')).toBe(false)
    })

    it('通配符写在中间不匹配', () => {
      expect(matchesDomainPattern('api.example.com', 'api.*.com')).toBe(false)
    })
  })

  it('IP 字面量可以精确匹配', () => {
    expect(matchesDomainPattern('127.0.0.1:9999', '127.0.0.1')).toBe(true)
    expect(matchesDomainPattern('127.0.0.2', '127.0.0.1')).toBe(false)
  })
})

describe('matchesAnyPattern', () => {
  it('命中任意一条即为真', () => {
    expect(matchesAnyPattern('api.example.com', ['other.com', '*.example.com'])).toBe(true)
  })

  it('一条都不命中为假', () => {
    expect(matchesAnyPattern('api.example.com', ['other.com', '.another.com'])).toBe(false)
  })

  it('空名单全为假', () => {
    expect(matchesAnyPattern('api.example.com', [])).toBe(false)
  })
})

describe('parseDomainPattern', () => {
  it('三种模式都解析成对应的形状', () => {
    expect(parseDomainPattern('api.example.com')).toEqual({
      ok: true,
      pattern: { kind: 'exact', host: 'api.example.com' },
    })
    expect(parseDomainPattern('*.example.com')).toEqual({
      ok: true,
      pattern: { kind: 'subdomains', host: 'example.com' },
    })
    expect(parseDomainPattern('.example.com')).toEqual({
      ok: true,
      pattern: { kind: 'domain', host: 'example.com' },
    })
  })

  it('归一化后存储，大小写不同不算两条规则', () => {
    expect(parseDomainPattern('API.Example.COM')).toEqual({
      ok: true,
      pattern: { kind: 'exact', host: 'api.example.com' },
    })
  })

  it('拒绝裸 *', () => {
    const result = parseDomainPattern('*')
    expect(result.ok).toBe(false)
  })

  it('拒绝只覆盖一个顶级域的通配', () => {
    // `*.com` 等于放行整个 .com，几乎不可能是本意。
    expect(parseDomainPattern('*.com').ok).toBe(false)
    expect(parseDomainPattern('.io').ok).toBe(false)
  })

  it('拒绝带协议或路径', () => {
    expect(parseDomainPattern('https://api.example.com').ok).toBe(false)
    expect(parseDomainPattern('api.example.com/v1').ok).toBe(false)
  })

  it('拒绝空串与非法域名', () => {
    expect(parseDomainPattern('').ok).toBe(false)
    expect(parseDomainPattern('-bad.example.com').ok).toBe(false)
    expect(parseDomainPattern('a..example.com').ok).toBe(false)
  })

  it('isValidDomainPattern 与 parse 的结论一致', () => {
    for (const input of ['api.example.com', '*.example.com', '.example.com', '*', '*.com', 'https://a.com', '']) {
      expect(isValidDomainPattern(input)).toBe(parseDomainPattern(input).ok)
    }
  })
})
