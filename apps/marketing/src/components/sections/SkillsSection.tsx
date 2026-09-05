import { Ico } from "./landing/icons";

/** "Teach it new skills" — skills on every plan; code-execution is the Pro tier. */
export function SkillsSection() {
  return (
    <section className="band" style={{ borderTop: "1px solid var(--border)" }}>
      <div className="wrap">
        <div className="center">
          <h2 className="sec">Teach it how you work</h2>
          <p className="sub">Write the steps once, save them as a skill, and anyone on the drive can run it. Pro skills can also run code.</p>
        </div>
        <div className="byo-grid">
          <div className="byo-copy">
            <ul className="byo-points">
              <li>
                <Ico name="file" size="i18" />
                <span><b>Made from a page.</b> <span className="d">Write the steps in plain words. No code required.</span></span>
              </li>
              <li>
                <Ico name="users" size="i18" />
                <span><b>Shared with your team.</b> <span className="d">Save it once and everyone on the drive can run it, instantly.</span></span>
              </li>
              <li>
                <Ico name="terminal" size="i18" />
                <span><b>Pro: skills that run code.</b> <span className="d">Give a skill the sandbox and it executes code, runs programs, and pulls tools from GitHub.</span></span>
              </li>
            </ul>
            <a className="pro-cta" href="/pricing">See what Pro adds<Ico name="arrowRight" /></a>
          </div>
          <div className="skill">
            <div className="sk-head">
              <span className="sk-badge"><Ico name="sparkle" size="i14" style={{ stroke: "currentColor" }} />Skill</span>
              <span className="sk-name">Weekly Report</span>
              <span className="sk-pro"><Ico name="terminal" size="i14" />Pro · runs code</span>
            </div>
            <div className="sk-body">
              <p className="sk-desc">&ldquo;Pull this week&rsquo;s numbers, build the chart, and post the summary to #leadership.&rdquo;</p>
              <div className="sk-lbl">Steps the AI follows</div>
              <div className="step"><span className="n">1</span>Read the metrics sheet</div>
              <div className="step"><span className="n">2</span>Run the analysis script<span className="run"><Ico name="terminal" size="i14" />runs code</span></div>
              <div className="step"><span className="n">3</span>Post the summary to #leadership</div>
            </div>
            <div className="sk-foot">Made from a page · shared with your drive</div>
          </div>
        </div>
      </div>
    </section>
  );
}
