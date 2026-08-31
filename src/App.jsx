import { useEffect, useState } from "react";

const navigation = [
  ["work", "Work"],
  ["capabilities", "Capabilities"],
  ["credentials", "Credentials"],
  ["evidence", "Evidence"],
  ["contact", "Contact"],
];

const projects = [
  {
    index: "01",
    status: "Completed",
    year: "2018",
    title: "Production flow and time study",
    organisation: "Cargill Joy Poultry Meats",
    brief:
      "Mapped production activity at task level to expose bottlenecks and make standard work easier to define.",
    methods: "Therbligs / process charts / time study / layout review",
    evidence:
      "Produced a documented view of work content, constraints, and improvement priorities for production decision-making.",
  },
  {
    index: "02",
    status: "Completed",
    year: "2020",
    title: "ISO 9001:2015 readiness review",
    organisation: "Pamantasan ng Cabuyao",
    brief:
      "Converted a quality-system gap assessment into a practical compliance roadmap for property and general services.",
    methods: "Clause review / evidence audit / nonconformance analysis",
    evidence:
      "Established a 58.43% overall baseline and identified Clause 9 at 33%, focusing action on documented information, internal audit, and management review.",
  },
  {
    index: "03",
    status: "Completed",
    year: "2021–22",
    title: "Physical plant readiness program",
    organisation: "Pamantasan ng Cabuyao",
    brief:
      "Coordinated evidence and facility improvements supporting the institution’s Level 1-to-Level 2 accreditation readiness.",
    methods: "Facility audit / ventilation review / maintenance planning",
    evidence:
      "Integrated signage, accessibility, ventilation assessment, and predictive-maintenance actions into one improvement program.",
  },
  {
    index: "04",
    status: "Portfolio study",
    year: "2026",
    title: "Customer engagement analysis",
    organisation: "365 Data Science project",
    brief:
      "Compared engagement behaviour across free- and paid-plan learners and translated descriptive statistics into business-facing insights.",
    methods: "Segmentation / distribution analysis / visual comparison",
    evidence:
      "Examined central tendency, confidence intervals, skewness, kurtosis, and hypothesis tests to support a segmented business recommendation.",
  },
  {
    index: "05",
    status: "System design",
    year: "2026",
    title: "90-day lead-generation workflow",
    organisation: "Panalo Pipes",
    brief:
      "Designed an execution-ready workflow connecting industrial targeting, lead qualification, follow-up, and management reporting.",
    methods: "Asana / forms / rules / custom fields / CRM logic",
    evidence:
      "Defined milestones, dependencies, ownership, next-action controls, and reporting fields for a measurable rollout.",
  },
];

const capabilities = [
  {
    number: "A",
    title: "Industrial engineering",
    body: "Time and motion study, process mapping, capacity thinking, standard work, facility planning, quality systems, and continuous improvement.",
  },
  {
    number: "B",
    title: "Data and workflow design",
    body: "Descriptive analysis, Excel-based reporting, Python foundations, KPI definition, Asana workflow architecture, and practical automation logic.",
  },
  {
    number: "C",
    title: "Fabrication context",
    body: "MIG fabrication, rebar cage production, drawing interpretation, Pedax Permatic operations, material handling, forklift, crane, and inventory coordination.",
  },
];

const timeline = [
  ["2014–17", "Production Controller", "Nestlé — Cabuyao Factory"],
  ["2017–18", "Production Analyst", "Cargill Joy Poultry Meats"],
  ["2018–22", "Director — Property Management & General Services", "Pamantasan ng Cabuyao"],
  ["2023–26", "Welder / Fabricator / Materials Operations", "Australian fabrication environments"],
  ["Now", "Industrial operations + data + workflow", "Connecting field reality with usable management systems"],
];

const credentials = [
  {
    code: "MEM40119",
    status: "Completed",
    title: "Certificate IV in Engineering",
    issuer: "Australian Institute of Engineering · Fabrication pathway",
    note: "Post-trade engineering study supporting higher-level fabrication, planning, and technical work.",
    href: "https://training.gov.au/training/details/MEM40119",
    linkLabel: "Qualification details",
  },
  {
    code: "CLSSYB",
    status: "Completed",
    title: "Lean Six Sigma Yellow Belt",
    issuer: "Continuous improvement credential",
    note: "Foundational DMAIC, waste identification, process mapping, and structured problem-solving capability.",
    href: null,
    linkLabel: null,
  },
  {
    code: "ASANA",
    status: "Capstone portfolio",
    title: "Workflow Specialist learning",
    issuer: "Asana Academy",
    note: "Scenario-based workflow design covering intake, approvals, automation, reporting, adoption, and governance.",
    href: "https://academy.asana.com/path/workflow-specialist-certificate",
    linkLabel: "Program details",
  },
  {
    code: "365 DS",
    status: "Project-based learning",
    title: "Data analytics development",
    issuer: "365 Data Science",
    note: "Applied statistics and business interpretation through portfolio studies, with Excel, SQL, Python, and BI skills in development.",
    href: "https://365datascience.com/career-tracks/data-analyst/",
    linkLabel: "Learning pathway",
  },
];

const resources = [
  {
    number: "01",
    type: "Core portfolio",
    title: "Professional portfolio package",
    description: "A concise employer-facing profile and a matching presentation covering industrial engineering, operations, data, and fabrication.",
    links: [
      { label: "Word portfolio", href: "/downloads/Jayson_Sugpatan_Professional_Portfolio.docx" },
      { label: "Presentation", href: "/downloads/Jayson_Sugpatan_Portfolio_Presentation.pptx" },
    ],
  },
  {
    number: "02",
    type: "Data analysis",
    title: "Customer engagement analysis",
    description: "A business-focused case study using descriptive statistics, confidence intervals, hypothesis testing, and decision recommendations.",
    links: [
      { label: "Case study", href: "/downloads/Customer_Engagement_Analysis_Portfolio.docx" },
      { label: "Interactive deck", href: "/downloads/Customer_Engagement_Analysis_Interactive_Portfolio.pptx" },
    ],
  },
  {
    number: "03",
    type: "Workflow design",
    title: "Asana workflow capstone",
    description: "A scenario-based operating system connecting request intake, approval, delivery, portfolio oversight, measurement, and adoption.",
    links: [
      { label: "Case study", href: "/downloads/Phoenix_Airlines_Asana_Capstone_Portfolio.docx" },
      { label: "Presentation", href: "/downloads/Phoenix_Airlines_Asana_Capstone_Deck.pptx" },
      { label: "Workbook", href: "/downloads/Phoenix_Airlines_Asana_Capstone_Workbook.xlsx" },
    ],
  },
];

const publicProof = [
  {
    label: "Published work",
    title: "ResearchGate record",
    detail: "Public author-contributions page listing five 2021 conference papers.",
    href: "https://www.researchgate.net/scientific-contributions/Jayson-Sugpatan-2217120874",
  },
  {
    label: "Professional association",
    title: "Industrial Engineers Australia",
    detail: "Jayson Sugpatan appears in the June/July 2023 new-member listing.",
    href: "https://iea.org.au/wp-content/uploads/Newsletter-16-IEA-10-07-23.pdf",
  },
  {
    label: "Leadership record",
    title: "Public university document",
    detail: "Publicly searchable documentation identifies the Property Management and General Services leadership role.",
    href: "https://www.scribd.com/document/611471519/UNIVERSITY-CANTEEN-CONTRACT-OF-LEASE",
  },
];

export default function App() {
  const [activeSection, setActiveSection] = useState("");
  const [headerCondensed, setHeaderCondensed] = useState(false);

  useEffect(() => {
    const sections = navigation
      .map(([id]) => document.getElementById(id))
      .filter(Boolean);

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleSection = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

        if (visibleSection) {
          setActiveSection(visibleSection.target.id);
        }
      },
      {
        rootMargin: "-18% 0px -64% 0px",
        threshold: [0.05, 0.2, 0.45],
      },
    );

    sections.forEach((section) => observer.observe(section));

    const updateHeader = () => setHeaderCondensed(window.scrollY > 32);
    updateHeader();
    window.addEventListener("scroll", updateHeader, { passive: true });

    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", updateHeader);
    };
  }, []);

  return (
    <main>
      <header className={`site-header${headerCondensed ? " is-scrolled" : ""}`}>
        <a className="wordmark" href="#top" aria-label="Jayson Sugpatan portfolio home">
          JS<span>/IE</span>
        </a>
        <nav aria-label="Portfolio navigation">
          {navigation.map(([id, label]) => (
            <a
              className={activeSection === id ? "is-active" : undefined}
              href={`#${id}`}
              aria-current={activeSection === id ? "location" : undefined}
              onClick={() => setActiveSection(id)}
              key={id}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <section className="hero technical-grid" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Industrial Engineer · Operations · Data · Fabrication</p>
          <h1>
            I turn real work into
            <span>clearer systems.</span>
          </h1>
          <p className="hero-intro">
            I connect shop-floor experience, industrial engineering, and data-driven workflow design—so teams can see the work, improve it, and manage it with confidence.
          </p>
          <div className="hero-actions">
            <a className="primary-link" href="#work">View selected work <span aria-hidden="true">↘</span></a>
            <a className="secondary-link" href="mailto:jayson.sugpatan.js@gmail.com">Email Jayson</a>
          </div>
          <div className="hero-contact" aria-label="Quick contact details">
            <a href="mailto:jayson.sugpatan.js@gmail.com">jayson.sugpatan.js@gmail.com</a>
            <a href="tel:+61423632786">+61 423 632 786</a>
            <span>Philippines-based · Australian industry experience</span>
          </div>
        </div>

        <aside className="profile-plate" aria-label="Professional snapshot">
          <div className="profile-photo-frame">
            <div className="profile-photo-shell">
              <img
                className="profile-photo"
                src="/images/jayson-profile-circular.png"
                alt="Jayson P. Sugpatan at the Australian Institute of Engineering"
                width="495"
                height="514"
              />
            </div>
            <span>Industrial + digital</span>
          </div>
          <div className="plate-code">PROFILE / 2026</div>
          <div className="plate-name">Jayson P. Sugpatan</div>
          <div className="profile-context-grid" aria-label="Professional profile photos">
            <figure>
              <img
                className="study-photo"
                src="/images/jayson-engineering-study.jpg"
                alt="Jayson Sugpatan at the Australian Institute of Engineering"
                width="900"
                height="1200"
              />
              <figcaption>Engineering study</figcaption>
            </figure>
            <figure>
              <img
                className="worksite-photo"
                src="/images/jayson-fabrication-site.jpg"
                alt="Jayson Sugpatan in fabrication safety gear beside a rebar cage"
                width="373"
                height="631"
              />
              <figcaption>Fabrication fieldwork</figcaption>
            </figure>
          </div>
          <dl>
            <div><dt>Foundation</dt><dd>BS Industrial Engineering</dd></div>
            <div><dt>Field depth</dt><dd>Production, facilities, fabrication</dd></div>
            <div><dt>System lens</dt><dd>Quality, data, workflow automation</dd></div>
            <div><dt>Perspective</dt><dd>Philippines + Australia experience</dd></div>
          </dl>
        </aside>
      </section>

      <section className="proof-band" aria-label="Professional value statement">
        <p>Observe the work.</p>
        <p>Structure the evidence.</p>
        <p>Build the system.</p>
      </section>

      <section className="section work-section" id="work">
        <div className="section-heading">
          <p className="eyebrow">Selected work</p>
          <h2>Evidence before adjectives.</h2>
          <p>Completed projects, portfolio studies, and system designs are labelled separately so the scope is always clear.</p>
        </div>

        <div className="project-list">
          {projects.map((project) => (
            <article className="project" id={`project-${project.index}`} key={project.index}>
              <div className="project-index">{project.index}</div>
              <div className="project-main">
                <div className="project-meta">
                  <span>{project.status}</span>
                  <span>{project.year}</span>
                </div>
                <h3>{project.title}</h3>
                <p className="organisation">{project.organisation}</p>
                <p className="project-brief">{project.brief}</p>
              </div>
              <div className="project-detail">
                <p><strong>Method</strong>{project.methods}</p>
                <p><strong>Evidence</strong>{project.evidence}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="section capability-section" id="capabilities">
        <div className="section-heading inverse">
          <p className="eyebrow">What I bring</p>
          <h2>One profile. Three working languages.</h2>
          <p>I can speak with operators, analysts, and managers because my experience crosses their day-to-day realities.</p>
        </div>
        <div className="capability-list">
          {capabilities.map((item) => (
            <article key={item.number}>
              <span>{item.number}</span>
              <h3>{item.title}</h3>
              <p>{item.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section experience-section" id="experience">
        <div className="section-heading">
          <p className="eyebrow">Experience trajectory</p>
          <h2>From analysis to leadership to the shop floor.</h2>
          <p>A career shaped by production control, operational leadership, fabrication, and the systems that connect them.</p>
        </div>
        <div className="timeline">
          {timeline.map(([year, role, org]) => (
            <div className="timeline-row" key={year}>
              <div className="timeline-year">{year}</div>
              <div><h3>{role}</h3><p>{org}</p></div>
            </div>
          ))}
        </div>

        <div className="education-card">
          <p className="eyebrow">Education base</p>
          <h3>Industrial thinking with practical range.</h3>
          <p><strong>BS Industrial Engineering</strong><span>Completed</span></p>
          <p><strong>MS Industrial Engineering</strong><span>Thesis in progress</span></p>
          <p><strong>Australian engineering study</strong><span>Fabrication pathway</span></p>
          <p><strong>Remote-work focus</strong><span>Data, reporting, workflows</span></p>
        </div>
      </section>

      <section className="section credential-section" id="credentials">
        <div className="section-heading">
          <p className="eyebrow">Credentials & learning</p>
          <h2>Qualifications backed by applied work.</h2>
          <p>Completed credentials are separated from current online learning and portfolio-based development.</p>
        </div>
        <div className="credential-grid">
          {credentials.map((credential) => (
            <article className="credential-card" key={credential.code}>
              <div className="credential-topline">
                <span>{credential.code}</span>
                <span>{credential.status}</span>
              </div>
              <h3>{credential.title}</h3>
              <p className="credential-issuer">{credential.issuer}</p>
              <p>{credential.note}</p>
              {credential.href ? (
                <a href={credential.href} target="_blank" rel="noreferrer">
                  {credential.linkLabel} <span aria-hidden="true">↗</span>
                </a>
              ) : (
                <span className="evidence-on-request">Certificate evidence available on request</span>
              )}
            </article>
          ))}
        </div>
        <p className="credential-note">
          Personal certificate files or issuer verification URLs can be added here when supplied. Program links describe the qualification or learning pathway and are not presented as personal verification records.
        </p>
      </section>

      <section className="section evidence-section" id="evidence">
        <div className="section-heading inverse">
          <p className="eyebrow">Employer-accessible evidence</p>
          <h2>Open the work. Check the public record.</h2>
          <p>Download selected portfolio files or review public professional sources in a new tab.</p>
        </div>

        <div className="resource-grid">
          {resources.map((resource) => (
            <article className="resource-card" key={resource.number}>
              <div className="resource-number">{resource.number}</div>
              <p className="resource-type">{resource.type}</p>
              <h3>{resource.title}</h3>
              <p>{resource.description}</p>
              <div className="resource-links">
                {resource.links.map((link) => (
                  <a href={link.href} key={link.href} target="_blank" rel="noreferrer">
                    {link.label} <span aria-hidden="true">↓</span>
                  </a>
                ))}
              </div>
            </article>
          ))}
        </div>

        <div className="public-proof">
          <div className="proof-title">
            <p className="eyebrow">Public professional footprint</p>
            <h3>Independent links employers can open.</h3>
          </div>
          <div className="proof-links">
            {publicProof.map((item) => (
              <a href={item.href} target="_blank" rel="noreferrer" key={item.title}>
                <span>{item.label}</span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
                <b aria-hidden="true">↗</b>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="contact-section technical-grid" id="contact">
        <p className="eyebrow">Open to the right work</p>
        <h2>Need someone who understands both the process and the people doing it?</h2>
        <p>
          I am open to industrial operations, process analysis, data and reporting, workflow coordination, and documentation-focused opportunities—including remote roles.
        </p>
        <div className="contact-actions">
          <a className="primary-link" href="mailto:jayson.sugpatan.js@gmail.com">Send an email <span aria-hidden="true">↗</span></a>
          <a className="secondary-link" href="tel:+61423632786">Call +61 423 632 786</a>
          <a className="secondary-link" href="https://www.researchgate.net/scientific-contributions/Jayson-Sugpatan-2217120874" target="_blank" rel="noreferrer">View published work</a>
        </div>
        <div className="contact-line">
          <span>Jayson P. Sugpatan</span>
          <a href="mailto:jayson.sugpatan.js@gmail.com">jayson.sugpatan.js@gmail.com</a>
          <span>Philippines-based · Australia industry experience</span>
        </div>
      </section>

      <footer>
        <span>Jayson P. Sugpatan</span>
        <span>Industrial systems, made usable.</span>
      </footer>
    </main>
  );
}
