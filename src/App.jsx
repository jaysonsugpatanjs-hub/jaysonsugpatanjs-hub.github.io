import { useEffect, useState } from "react";
import LeadPilotInquiryForm from "./LeadPilotH8.jsx";

const CONTACT_EMAIL = "jayson.sugpatan.js@gmail.com";

const navigation = [
  ["services", "Services"],
  ["work", "Case studies"],
  ["capabilities", "Strengths"],
  ["tools", "Tools"],
  ["evidence", "Evidence"],
  ["contact", "Contact"],
];

const remoteServices = [
  {
    code: "01",
    title: "CRM & pipeline coordination",
    body: "Keep lead records, follow-ups, stages, owners, and next actions organised so opportunities do not disappear between conversations.",
    output: "Pipeline hygiene · follow-up control · management visibility",
  },
  {
    code: "02",
    title: "Lead & tender research",
    body: "Research industrial opportunities, decision-makers, tender sources, and account context, then structure the findings for practical qualification.",
    output: "Target lists · opportunity briefs · pursuit priorities",
  },
  {
    code: "03",
    title: "Reporting & data support",
    body: "Turn operational, sales, or project data into usable trackers, summaries, and recurring reports for faster decisions.",
    output: "Excel / Sheets trackers · KPI summaries · data cleanup",
  },
  {
    code: "04",
    title: "Quotations & business documents",
    body: "Coordinate the information behind quotations, scopes, proposals, capability statements, and controlled internal documents.",
    output: "Submission packs · document control · action registers",
  },
  {
    code: "05",
    title: "Workflow & automation design",
    body: "Map handoffs, define ownership, and configure practical forms, rules, alerts, and task flows using no-code and AI-assisted tools.",
    output: "SOPs · Asana workflows · n8n / Make logic",
  },
  {
    code: "06",
    title: "Industrial operations support",
    body: "Provide remote coordination grounded in production, procurement, fabrication, inventory, maintenance, and site-facing experience.",
    output: "Production support · supplier research · technical records",
  },
];

const projects = [
  {
    index: "01",
    status: "AI-assisted implementation",
    year: "2026",
    title: "Consent-based portfolio lead capture",
    organisation: "Personal portfolio system",
    brief:
      "Needed a privacy-aware way to understand visitor intent, qualify genuine enquiries, and prevent promising contacts from being lost.",
    methods: "Requirements / React / GitHub Pages / CRM API / consent events / n8n handoff",
    evidence:
      "Specified and delivered a live intake path with explicit consent, structured qualification fields, an owner-only CRM, and the existing HubSpot automation retained as a secondary route.",
  },
  {
    index: "02",
    status: "System design",
    year: "2026",
    title: "90-day lead-generation workflow",
    organisation: "Panalo Pipes",
    brief:
      "Needed an execution-ready system connecting industrial targeting, lead qualification, follow-up, ownership, and management reporting.",
    methods: "Asana / forms / rules / custom fields / CRM logic / reporting cadence",
    evidence:
      "Defined milestones, dependencies, next-action controls, escalation points, and reporting fields for a measurable 90-day pilot.",
  },
  {
    index: "03",
    status: "Portfolio study",
    year: "2026",
    title: "Customer engagement analysis",
    organisation: "365 Data Science project",
    brief:
      "Needed to compare engagement behaviour across free- and paid-plan learners and translate statistics into business-facing insight.",
    methods: "Segmentation / distribution analysis / confidence intervals / hypothesis tests",
    evidence:
      "Produced a segmented analysis of central tendency, skewness, kurtosis, and confidence intervals to support a practical business recommendation.",
  },
  {
    index: "04",
    status: "Completed",
    year: "2020",
    title: "ISO 9001:2015 readiness review",
    organisation: "Pamantasan ng Cabuyao",
    brief:
      "Needed a clear baseline for quality-system readiness and a practical route from evidence gaps to corrective action.",
    methods: "Clause review / evidence audit / nonconformance analysis / action planning",
    evidence:
      "Established a 58.43% overall baseline and identified Clause 9 at 33%, focusing action on documented information, internal audit, and management review.",
  },
  {
    index: "05",
    status: "Completed",
    year: "2018",
    title: "Production flow and time study",
    organisation: "Cargill Joy Poultry Meats",
    brief:
      "Needed a task-level view of production activity to expose bottlenecks and make standard work easier to define.",
    methods: "Therbligs / process charts / time study / layout review",
    evidence:
      "Produced a documented view of work content, constraints, and improvement priorities for production decision-making.",
  },
  {
    index: "06",
    status: "Completed",
    year: "2021–22",
    title: "Physical plant readiness program",
    organisation: "Pamantasan ng Cabuyao",
    brief:
      "Needed coordinated facility evidence and improvements to support the institution’s Level 1-to-Level 2 accreditation readiness.",
    methods: "Facility audit / ventilation review / maintenance planning / evidence coordination",
    evidence:
      "Integrated signage, accessibility, ventilation assessment, and predictive-maintenance actions into one improvement program.",
  },
];

const capabilities = [
  {
    number: "A",
    title: "Operations & coordination",
    body: "Production control, procurement support, records, priorities, action tracking, stakeholder coordination, and practical follow-through.",
  },
  {
    number: "B",
    title: "Data & reporting",
    body: "Excel and Google Sheets reporting, descriptive analysis, KPI definition, tracker design, data cleanup, and management-ready summaries.",
  },
  {
    number: "C",
    title: "CRM & commercial support",
    body: "Lead research, pipeline administration, follow-up controls, tender monitoring, capability documents, and business-development coordination.",
  },
  {
    number: "D",
    title: "Industrial field context",
    body: "Industrial engineering, production, facilities, fabrication, drawings, materials, inventory, and Australian workshop experience.",
  },
];

const toolGroups = [
  {
    status: "Applied",
    title: "Operations & delivery",
    tools: ["Microsoft Excel", "Google Sheets", "SAP", "Asana"],
    note: "Production control, trackers, task governance, records, procurement support, and recurring reporting.",
  },
  {
    status: "Applied",
    title: "CRM & growth support",
    tools: ["HubSpot", "Lead research", "Pipeline reporting", "Proposal support"],
    note: "Structured lead capture, qualification, next actions, opportunity research, and management visibility.",
  },
  {
    status: "Applied / developing",
    title: "Automation & AI",
    tools: ["n8n", "Make", "ChatGPT", "Workflow logic"],
    note: "AI-assisted requirements, forms, routing, alerts, integrations, SOPs, and repeatable work instructions.",
  },
  {
    status: "Developing",
    title: "Analytics stack",
    tools: ["SQL", "Power BI", "Python", "Business statistics"],
    note: "Clearly labelled development supported by portfolio exercises rather than presented as unverified expert-level experience.",
  },
];

const workModes = [
  ["Location", "Philippines-based remote support"],
  ["Coverage", "Practical overlap with Australian business hours"],
  ["Engagement", "Part-time contract · 90-day pilot · project-based · ongoing role"],
  ["Best fit", "Industrial · construction · manufacturing · technical services"],
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
              data-track="navigation"
              data-track-label={`Header: ${label}`}
              onClick={() => {
                setActiveSection(id);
              }}
              key={id}
            >
              {label}
            </a>
          ))}
        </nav>
      </header>

      <section className="hero technical-grid" id="top">
        <div className="hero-copy">
          <p className="eyebrow">Remote Operations & Business Support · Industrial & Technical Teams</p>
          <h1>
            Remote support for
            <span>real industrial work.</span>
          </h1>
          <p className="hero-intro">
            I help Australian industrial, construction, manufacturing, and technical-service teams manage CRM, lead and tender research, reporting, documentation, and workflow coordination—from the Philippines with practical overlap to Australian business hours.
          </p>
          <div className="hero-actions">
            <a className="primary-link" href="#services" data-track="navigation" data-track-label="Hero: Explore remote services">Explore remote services <span aria-hidden="true">↘</span></a>
            <a
              className="secondary-link"
              href="#contact"
              data-track="navigation"
              data-track-label="Hero: Discuss remote support"
            >
              Discuss remote support
            </a>
          </div>
          <div className="hero-contact" aria-label="Quick contact details">
            <a href={`mailto:${CONTACT_EMAIL}`} data-track="contact_click" data-track-label="Hero details: Email">
              {CONTACT_EMAIL}
            </a>
            <a
              href="/downloads/Jayson_Sugpatan_Professional_Portfolio.docx"
              target="_blank"
              rel="noreferrer"
              data-track="download"
              data-track-label="Hero: Download professional portfolio"
            >
              Download professional portfolio
            </a>
            <span>Philippines-based · Australian business-hours overlap</span>
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
            <span>Remote + industrial</span>
          </div>
          <div className="plate-code">REMOTE OPS / 2026</div>
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
            <div><dt>Remote value</dt><dd>CRM, research, reporting, coordination</dd></div>
            <div><dt>Field depth</dt><dd>Production, facilities, fabrication</dd></div>
            <div><dt>Coverage</dt><dd>Philippines base + Australian context</dd></div>
          </dl>
        </aside>
      </section>

      <section className="proof-band" aria-label="Professional value statement">
        <p>Understand the work.</p>
        <p>Control the follow-up.</p>
        <p>Report what matters.</p>
      </section>

      <section
        className={`section services-section technical-grid nav-section${activeSection === "services" ? " is-selected" : ""}`}
        id="services"
      >
        <div className="section-heading">
          <p className="eyebrow">Remote services</p>
          <h2>Specialised support, not generic task handling.</h2>
          <p>I combine virtual delivery with industrial context, so the work is organised around real operations, commercial priorities, and management decisions.</p>
        </div>

        <div className="service-grid">
          {remoteServices.map((service) => (
            <article className="service-card" key={service.code}>
              <div className="service-code">{service.code}</div>
              <h3>{service.title}</h3>
              <p>{service.body}</p>
              <small>{service.output}</small>
            </article>
          ))}
        </div>

        <div className="work-mode-panel" aria-labelledby="work-mode-title">
          <div>
            <p className="eyebrow">Working arrangement</p>
            <h3 id="work-mode-title">Built for practical remote collaboration.</h3>
            <p>Clear deliverables, visible next actions, and reporting that lets managers see progress without chasing updates.</p>
          </div>
          <dl>
            {workModes.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </div>
      </section>

      <section
        className={`section work-section nav-section${activeSection === "work" ? " is-selected" : ""}`}
        id="work"
      >
        <div className="section-heading">
          <p className="eyebrow">Case studies</p>
          <h2>Problems, contribution, evidence.</h2>
          <p>Each example states whether it is completed work, a portfolio study, a system design, or an AI-assisted implementation—so the scope remains clear.</p>
        </div>

        <div className="project-list">
          {projects.map((project) => (
            <article
              className="project"
              id={`project-${project.index}`}
              key={project.index}
              data-track-view="project_view"
              data-track-label={`Project viewed: ${project.title}`}
            >
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
                <p><strong>Contribution</strong>{project.methods}</p>
                <p><strong>Outcome / evidence</strong>{project.evidence}</p>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section
        className={`section capability-section nav-section${activeSection === "capabilities" ? " is-selected" : ""}`}
        id="capabilities"
      >
        <div className="section-heading inverse">
          <p className="eyebrow">Transferable strengths</p>
          <h2>Remote support with operational context.</h2>
          <p>I can work across operators, analysts, commercial teams, and managers because my experience connects their day-to-day realities.</p>
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

      <section
        className={`section tools-section nav-section${activeSection === "tools" ? " is-selected" : ""}`}
        id="tools"
      >
        <div className="section-heading">
          <p className="eyebrow">Tools & systems</p>
          <h2>Applied capability, clearly labelled.</h2>
          <p>Tools used in operations and portfolio work are separated from developing analytics skills, avoiding inflated proficiency claims.</p>
        </div>
        <div className="tools-grid">
          {toolGroups.map((group) => (
            <article className="tool-card" key={group.title}>
              <div className="tool-card-topline">
                <span>{group.status}</span>
                <span aria-hidden="true">↗</span>
              </div>
              <h3>{group.title}</h3>
              <ul>
                {group.tools.map((tool) => <li key={tool}>{tool}</li>)}
              </ul>
              <p>{group.note}</p>
            </article>
          ))}
        </div>
        <div className="tools-positioning-note">
          <strong>Positioning advantage</strong>
          <p>I am not presenting as a generalist VA who happens to know industrial words. I bring real production, facilities, fabrication, procurement, and Australian workshop context into remote business support.</p>
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

      <section
        className={`section credential-section nav-section${activeSection === "credentials" ? " is-selected" : ""}`}
        id="credentials"
      >
        <div className="section-heading">
          <p className="eyebrow">Credentials & learning</p>
          <h2>Qualifications backed by applied work.</h2>
          <p>Completed credentials are separated from current online learning and portfolio-based development.</p>
        </div>
        <div className="credential-grid">
          {credentials.map((credential) => (
            <article
              className="credential-card"
              key={credential.code}
              data-track-view="credential_view"
              data-track-label={`Credential viewed: ${credential.title}`}
            >
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

      <section
        className={`section evidence-section nav-section${activeSection === "evidence" ? " is-selected" : ""}`}
        id="evidence"
      >
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
                  <a
                    href={link.href}
                    key={link.href}
                    target="_blank"
                    rel="noreferrer"
                    data-track="download"
                    data-track-label={`${resource.title}: ${link.label}`}
                  >
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
              <a
                href={item.href}
                target="_blank"
                rel="noreferrer"
                key={item.title}
                data-track="external_link"
                data-track-label={`Public proof: ${item.title}`}
              >
                <span>{item.label}</span>
                <strong>{item.title}</strong>
                <small>{item.detail}</small>
                <b aria-hidden="true">↗</b>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section
        className={`contact-section technical-grid nav-section${activeSection === "contact" ? " is-selected" : ""}`}
        id="contact"
      >
        <p className="eyebrow">Remote operations support</p>
        <h2>Need reliable follow-through behind the work?</h2>
        <p className="contact-intro">
          I am open to part-time contracts, 90-day pilots, project-based engagements, and ongoing remote roles supporting Australian industrial and technical businesses.
        </p>

        <div className="contact-grid">
          <aside className="contact-options" aria-labelledby="direct-contact-title">
            <p className="contact-label">Direct contact</p>
            <h3 id="direct-contact-title">Discuss the workload.</h3>
            <p>Share the operating problem, recurring tasks, reporting need, or opportunity you want controlled. I can then assess the most practical support arrangement.</p>
            <div className="contact-actions">
              <a
                className="primary-link"
                href={`mailto:${CONTACT_EMAIL}?subject=Portfolio%20inquiry`}
                data-track="contact_click"
                data-track-label="Contact: Email"
              >
                Send an email <span aria-hidden="true">↗</span>
              </a>
              <a
                className="secondary-link"
                href="tel:+61423632786"
                data-track="contact_click"
                data-track-label="Contact: Phone"
              >
                Call +61 423 632 786
              </a>
            </div>
            <dl className="contact-details">
              <div>
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${CONTACT_EMAIL}`} data-track="contact_click" data-track-label="Contact details: Email">
                    {CONTACT_EMAIL}
                  </a>
                </dd>
              </div>
              <div><dt>Location</dt><dd>Philippines · Australian industry experience</dd></div>
              <div><dt>Availability</dt><dd>Australian business-hours overlap</dd></div>
              <div><dt>Engagement</dt><dd>Contract · 90-day pilot · Project · Ongoing role</dd></div>
            </dl>
          </aside>

          <LeadPilotInquiryForm />
        </div>

        <div className="contact-line">
          <span>Jayson P. Sugpatan</span>
          <a href={`mailto:${CONTACT_EMAIL}`} data-track="contact_click" data-track-label="Contact footer: Email">{CONTACT_EMAIL}</a>
          <span>Philippines-based · Australian industry experience</span>
        </div>
      </section>

      <section className="privacy-section" id="privacy" aria-labelledby="privacy-title">
        <div>
          <p className="eyebrow">Privacy & data use</p>
          <h2 id="privacy-title">Clear consent. Limited purpose.</h2>
        </div>
        <div className="privacy-copy">
          <p>Anonymous portfolio activity is recorded only after a visitor allows analytics. Identifiable information is collected only when an enquiry form is submitted with consent.</p>
          <p>Enquiry details are stored in Jayson’s private portfolio CRM and may be sent to the connected HubSpot workflow for assessment and follow-up. Visitors can request correction or deletion by emailing <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>.</p>
        </div>
      </section>

      <footer>
        <span>Jayson P. Sugpatan</span>
        <span>Remote operations support, grounded in industry.</span>
        <div className="footer-controls">
          <a href="#privacy">Privacy & data use</a>
          <button type="button" data-leadpilot-consent-settings>Analytics preferences</button>
          <a href="https://jayson-sugpatan-portfolio.jayrisse1490.chatgpt.site/crm" target="_blank" rel="noreferrer">Owner CRM</a>
        </div>
      </footer>
    </main>
  );
}
