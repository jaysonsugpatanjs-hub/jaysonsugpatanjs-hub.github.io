import { useMemo, useState } from "react";
import "./leadpilot-h8.css";

const PORTFOLIO_CRM_INQUIRY_URL =
  "https://jayson-sugpatan-portfolio.jayrisse1490.chatgpt.site/api/inquiry";
const LEADPILOT_INBOUND_URL =
  "https://jaysonsugpatan1490.app.n8n.cloud/webhook/leadpilot-inbound";
const CONTACT_EMAIL = "jayson.sugpatan.js@gmail.com";
const CONSENT_VERSION = "2026-09";

const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "outlook.com",
  "hotmail.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
  "live.com",
]);

const SERVICE_OPTIONS = [
  { value: "employment", label: "Employment or contract role" },
  { value: "operations", label: "Industrial operations or process improvement" },
  { value: "data_automation", label: "Data, reporting or workflow automation" },
  { value: "fabrication", label: "Fabrication or technical support" },
  { value: "collaboration", label: "Business development or collaboration" },
  { value: "general", label: "Other enquiry" },
];

function randomId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function trackingContext() {
  return window.LeadPilotTracking?.getContext() ?? {
    visitorId: randomId(),
    sessionId: randomId(),
    consentVersion: CONSENT_VERSION,
  };
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0];
}

function domainFromEmail(email) {
  const domain = String(email || "").trim().toLowerCase().split("@")[1] || "";
  return PUBLIC_EMAIL_DOMAINS.has(domain) ? "" : domain;
}

function acquisitionMetadata() {
  const params = new URLSearchParams(window.location.search);
  return {
    page_url: window.location.href,
    utm_source: params.get("utm_source") || "",
    utm_medium: params.get("utm_medium") || "",
    utm_campaign: params.get("utm_campaign") || "",
    utm_content: params.get("utm_content") || "",
    utm_term: params.get("utm_term") || "",
    referrer: document.referrer || "",
  };
}

function mirrorToHubSpot(payload) {
  const requestBody = new URLSearchParams();
  Object.entries(payload).forEach(([key, value]) =>
    requestBody.set(key, String(value ?? "")),
  );

  void fetch(LEADPILOT_INBOUND_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: requestBody.toString(),
    keepalive: true,
  }).catch(() => undefined);
}

export default function LeadPilotInquiryForm() {
  const [status, setStatus] = useState("idle");
  const [feedback, setFeedback] = useState("");
  const [startedAt] = useState(() => Date.now());

  const buttonLabel = useMemo(() => {
    if (status === "sending") return "Saving inquiry…";
    if (status === "success") return "Inquiry received ✓";
    return "Send inquiry";
  }, [status]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (status === "sending") return;

    const form = event.currentTarget;
    const data = new FormData(form);
    const firstname = String(data.get("firstname") || "").trim();
    const lastname = String(data.get("lastname") || "").trim();
    const email = String(data.get("email") || "").trim().toLowerCase();
    const phone = String(data.get("phone") || "").trim();
    const companyName = String(data.get("company_name") || "").trim();
    const role = String(data.get("job_title") || "").trim();
    const inquiryType = String(data.get("inquiry_type") || "").trim();
    const timeline = String(data.get("timeline") || "exploring").trim();
    const preferredContact = String(data.get("preferred_contact") || "email").trim();
    const suppliedDomain = normalizeDomain(data.get("company_domain"));
    const companyDomain = suppliedDomain || domainFromEmail(email);
    const message = String(data.get("message") || "").trim();
    const honeypot = String(data.get("website_check") || "").trim();
    const consent = data.get("contact_consent") === "on";

    if (!firstname || !lastname || !email || !companyName || !inquiryType || !message) {
      setStatus("error");
      setFeedback("Please complete all required fields before sending your inquiry.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("error");
      setFeedback("Please enter a valid email address.");
      return;
    }

    if (preferredContact === "phone" && !phone) {
      setStatus("error");
      setFeedback("Please add a phone number if you would like a phone response.");
      return;
    }

    if (message.length < 20) {
      setStatus("error");
      setFeedback("Please provide a little more project or opportunity detail so I can respond properly.");
      return;
    }

    if (!consent) {
      setStatus("error");
      setFeedback("Please confirm that your enquiry details may be stored for assessment and follow-up.");
      return;
    }

    if (honeypot) {
      setStatus("success");
      setFeedback("Thank you. Your inquiry has been received.");
      return;
    }

    const context = trackingContext();
    const service =
      SERVICE_OPTIONS.find((option) => option.value === inquiryType)?.label ?? "Other enquiry";
    const metadata = acquisitionMetadata();

    setStatus("sending");
    setFeedback("Saving your inquiry to the private portfolio CRM…");

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      const response = await fetch(PORTFOLIO_CRM_INQUIRY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...context,
          name: `${firstname} ${lastname}`,
          email,
          phone,
          company: companyName,
          role,
          inquiryType,
          timeline,
          preferredContact,
          message,
          website: "",
          path: `${window.location.pathname}${window.location.hash}`,
          consent: true,
        }),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.error || `Portfolio CRM returned ${response.status}`);
      }

      mirrorToHubSpot({
        firstname,
        lastname,
        email,
        phone,
        company_name: companyName,
        company_domain: companyDomain,
        job_title: role,
        service_requirement: service,
        timeline,
        preferred_contact: preferredContact,
        message,
        leadpilot_source: "Website",
        source_detail: "GitHub Portfolio — consented private CRM capture",
        submitted_at: new Date().toISOString(),
        portfolio_inquiry_id: result?.inquiryId || "",
        website_check: "",
        client_form_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        ...metadata,
      });

      setStatus("success");
      setFeedback("Thank you—your inquiry is saved and ready for follow-up.");
      form.reset();
    } catch (error) {
      setStatus("error");
      setFeedback(
        error?.name === "AbortError"
          ? "The inquiry service took too long to respond. Please try again or use the email option beside this form."
          : "I couldn’t confirm delivery. Please try again or use the email option beside this form.",
      );
    }
  }

  return (
    <section className="inquiry-form" aria-labelledby="leadpilot-inquiry-title">
      <div className="leadpilot-h8-heading">
        <p className="contact-label">Private portfolio CRM</p>
        <h3 id="leadpilot-inquiry-title">Tell me about the opportunity.</h3>
        <p>Your enquiry is connected to the portfolio activity you chose to share, helping me respond with better context.</p>
      </div>

      <form className="leadpilot-h8-form" onSubmit={handleSubmit} data-leadpilot-form>
        <div className="leadpilot-h8-grid">
          <label>
            <span>First name *</span>
            <input name="firstname" autoComplete="given-name" maxLength="60" required />
          </label>
          <label>
            <span>Last name *</span>
            <input name="lastname" autoComplete="family-name" maxLength="60" required />
          </label>
          <label>
            <span>Work email *</span>
            <input name="email" type="email" autoComplete="email" maxLength="180" required />
          </label>
          <label>
            <span>Phone</span>
            <input name="phone" type="tel" autoComplete="tel" maxLength="40" />
          </label>
          <label>
            <span>Company / organisation *</span>
            <input name="company_name" autoComplete="organization" maxLength="140" required />
          </label>
          <label>
            <span>Role / job title</span>
            <input name="job_title" autoComplete="organization-title" maxLength="140" />
          </label>
          <label className="leadpilot-h8-wide">
            <span>Company website / domain</span>
            <input name="company_domain" inputMode="url" maxLength="180" placeholder="example.com" />
            <small>Optional; helps match your enquiry to the right company record.</small>
          </label>
          <label className="leadpilot-h8-wide">
            <span>Service / opportunity *</span>
            <select name="inquiry_type" defaultValue="" required>
              <option value="" disabled>Select the closest match</option>
              {SERVICE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label>
            <span>Timeframe</span>
            <select name="timeline" defaultValue="exploring">
              <option value="asap">As soon as possible</option>
              <option value="one_month">Within one month</option>
              <option value="one_to_three_months">Within 1–3 months</option>
              <option value="exploring">Exploring options</option>
            </select>
          </label>
          <label>
            <span>Preferred response</span>
            <select name="preferred_contact" defaultValue="email">
              <option value="email">Email</option>
              <option value="phone">Phone</option>
            </select>
          </label>
          <label className="leadpilot-h8-wide">
            <span>Project / opportunity details *</span>
            <textarea
              name="message"
              rows="6"
              minLength="20"
              maxLength="2000"
              placeholder="Scope, problem to solve, timing, location, deliverables, or the role you are hiring for."
              required
            />
          </label>
        </div>

        <label className="leadpilot-h8-honeypot" aria-hidden="true">
          Website
          <input name="website_check" tabIndex="-1" autoComplete="off" />
        </label>

        <label className="leadpilot-h8-consent">
          <input name="contact_consent" type="checkbox" required />
          <span>
            I agree that my details and this visit’s activity may be stored in Jayson’s private portfolio CRM and sent to the connected HubSpot CRM for assessment and follow-up.
          </span>
        </label>

        <div className="leadpilot-h8-submit-row">
          <button
            className="primary-link"
            type="submit"
            disabled={status === "sending" || status === "success"}
            data-track="contact_click"
            data-track-label="Contact form: Send inquiry"
          >
            {buttonLabel}<span aria-hidden="true">↗</span>
          </button>
          <p className={`leadpilot-h8-status is-${status}`} role="status" aria-live="polite">
            {feedback || "Required fields are marked with *. Do not include passwords or sensitive personal information."}
          </p>
        </div>
      </form>

      <p className="form-privacy leadpilot-h8-privacy">
        Anonymous portfolio activity is collected only when analytics is allowed. Your identity is linked only after this form is submitted. If the form is unavailable, email{" "}
        <a href={`mailto:${CONTACT_EMAIL}?subject=Portfolio%20inquiry`}>{CONTACT_EMAIL}</a>.
      </p>
    </section>
  );
}
