// 官网首页。文案的权威来源是 specs/README.md 的「与 OSW 的关系」一节：
// 安全叙事的落点是「舱里压根不存在一个可以泄漏的密钥」。
const POINTS = [
  { title: '一个地址', body: '舱内 agent 只有一个自定义供应商、一个 baseUrl。没有供应商列表。' },
  { title: '没有密钥', body: '模型和密钥都在 OSW。舱里的 apiKey 是无条件被替换的占位符。' },
  { title: '默认拒绝', body: '白名单外的域名一律拦下并记录，不需要你去配置收紧。' },
  { title: '一切可查', body: '每次出网、每件出舱的东西都留一条可回溯的记录。' },
] as const

export const App = () => (
  <main className="page">
    <header className="hero">
      <p className="eyebrow">macOS 托盘应用</p>
      <h1>abx</h1>
      <p className="lead">
        给 AI coding agent 用的隔离舱。它在里面像在本机一样干活，
        但拿不到你的密钥，也出不去。
      </p>
    </header>

    <section className="points">
      {POINTS.map(point => (
        <article key={point.title} className="point">
          <h2>{point.title}</h2>
          <p>{point.body}</p>
        </article>
      ))}
    </section>

    <footer className="foot">第一版只做 macOS。</footer>
  </main>
)
