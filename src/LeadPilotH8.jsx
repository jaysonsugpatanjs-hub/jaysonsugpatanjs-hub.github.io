import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import "./leadpilot-h8.css";

const LEADPILOT_INBOUND_URL = "https://jaysonsugpatan1490.app.n8n.cloud/webhook/leadpilot-inbound";
const CONTACT_EMAIL = "jayson.sugpatan.js@gmail.com";
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
  "Industrial Operations / Process Improvement",
  "Data / Reporting / Workflow Automation",
  "Fabrication / Technical Support",
  "Business Development / CRM Automation",
  "Shutdown & Maintenance / Coded Welding",
  "Other",
];

function trackLeadEvent(name, metadata = {}) {
  if (typeof window === "undefined") return;
  if (typeof window.sa_event === "function") {
    window.sa_event(name, metadata);
  }
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
  if (typeof window === "undefined") return {};
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

function LeadPilotInquiryForm() {
  const [status, setStatus] = useState("idle");
  const [feedback, setFeedback] = useState("");
  const [startedAt] = useState(() => Date.now());

  const buttonLabel = useMemo(() => {
    if (status === "sending") return "Sending inquiry…";
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
    const companyName = String(data.get("company_name") || "").trim();
    const suppliedDomain = normalizeDomain(data.get("company_domain"));
    const companyDomain = suppliedDomain || domainFromEmail(email);
    const service = String(data.get("service_requirement") || "").trim();
    const message = String(data.get("message") || "").trim();
    const honeypot = String(data.get("website_check") || "").trim();

    if (!firstname || !lastname || !email || !companyName || !service || !message) {
      setStatus("error");
      setFeedback("Please complete all required fields before sending your inquiry.");
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("error");
      setFeedback("Please enter a valid email address.");
      return;
    }

    if (!companyDomain) {
      setStatus("error");
      setFeedback("Please add your company website/domain when using Gmail, Yahoo, Outlook, or another personal email address.");
      return;
    }

    if (message.length < 20) {
      setStatus("error");
      setFeedback("Please provide a little more project or opportunity detail so I can respond properly.");
      return;
    }

    if (honeypot) {
      setStatus("success");
      setFeedback("Thank you. Your inquiry has been received.");
      return;
    }

    const metadata = acquisitionMetadata();
    const payload = {
      firstname,
      lastname,
      email,
      phone: String(data.get("phone") || "").trim(),
      company_name: companyName,
      company_domain: companyDomain,
      job_title: String(data.get("job_title") || "").trim(),
      service_requirement: service,
      message,
      leadpilot_source: "Website",
      source_detail: "GitHub Portfolio — H8 Live Website Lead Capture",
      submitted_at: new Date().toISOString(),
      website_check: "",
      client_form_seconds: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
      ...metadata,
    };

    const requestBody = new URLSearchParams();
    Object.entries(payload).forEach(([key, value]) => requestBody.set(key, String(value ?? "")));

    setStatus("sending");
    setFeedback("Sending your inquiry securely to LeadPilot…");

    try {
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 20000);
      const response = await fetch(LEADPILOT_INBOUND_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: requestBody.toString(),
        signal: controller.signal,
      });
      window.clearTimeout(timeout);

      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }

      if (!response.ok || result?.accepted === false) {
        const serverMessage = Array.isArray(result?.errors) ? result.errors.join("; ") : "";
        throw new Error(serverMessage || `LeadPilot returned ${response.status}`);
      }

      setStatus("success");
      setFeedback("Thank you—your inquiry is recorded and ready for follow-up.");
      trackLeadEvent("leadpilot_inquiry_sent", {
        source: "website",
        service,
        acquisition: metadata.utm_source ? "campaign" : metadata.referrer ? "referral" : "direct",
        crm_status: result?.status || result?.crm?.status || "accepted",
      });
      form.reset();
    } catch (error) {
      const timeoutMessage = error?.name === "AbortError";
      setStatus("error");
      setFeedback(
        timeoutMessage
          ? "The inquiry service took too long to respond. Please try once more or use the email option beside this form."
          : "I couldn’t confirm delivery. Please try again or use the email option beside this form.",
      );
      trackLeadEvent("leadpilot_inquiry_failed", {
        source: "website",
        reason: error?.name || "request_error",
      });
    }
  }

  return (
    <div className="leadpilot-h8-shell">
      <div className="form-heading leadpilot-h8-heading">
        <p className="contact-label">LeadPilot live inquiry</p>
        <h3 id="leadpilot-inquiry-title">Tell me about the opportunity.</h3>
        <p>Your inquiry now flows through LeadPilot for structured qualification, CRM capture, and follow-up.</p>
      </div>

      <form className="leadpilot-h8-form" onSubmit={handleSubmit} aria-labelledby="leadpilot-inquiry-title">
        <div className="leadpilot-h8-grid">
          <label>
            <span>First name *</span>
            <input name="firstname" autoComplete="given-name" required />
          </label>
          <label>
            <span>Last name *</span>
            <input name="lastname" autoComplete="family-name" required />
          </label>
          <label>
            <span>Work email *</span>
            <input name="email" type="email" autoComplete="email" required />
          </label>
          <label>
            <span>Phone</span>
            <input name="phone" type="tel" autoComplete="tel" />
          </label>
          <label>
            <span>Company / organisation *</span>
            <input name="company_name" autoComplete="organization" required />
          </label>
          <label>
            <span>Role / job title</span>
            <input name="job_title" autoComplete="organization-title" />
          </label>
          <label className="leadpilot-h8-wide">
            <span>Company website / domain</span>
            <input name="company_domain" inputMode="url" placeholder="example.com" />
            <small>Needed when you use a personal email address such as Gmail or Outlook.</small>
          </label>
          <label className="leadpilot-h8-wide">
            <span>Service / opportunity *</span>
            <select name="service_requirement" defaultValue="" required>
              <option value="" disabled>Select the closest match</option>
              {SERVICE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="leadpilot-h8-wide">
            <span>Project / opportunity details *</span>
            <textarea
              name="message"
              rows="6"
              minLength="20"
              placeholder="Scope, problem to solve, timing, location, deliverables, or the role you are hiring for."
              required
            />
          </label>
        </div>

        <label className="leadpilot-h8-honeypot" aria-hidden="true">
          Website
          <input name="website_check" tabIndex="-1" autoComplete="off" />
        </label>

        <div className="leadpilot-h8-submit-row">
          <button className="primary-link" type="submit" disabled={status === "sending" || status === "success"}>
            {buttonLabel}<span aria-hidden="true">↗</span>
          </button>
          <p className={`leadpilot-h8-status is-${status}`} role="status" aria-live="polite">
            {feedback || "Required fields are marked with *. No passwords or sensitive personal information."}
          </p>
        </div>
      </form>

      <p className="form-privacy leadpilot-h8-privacy">
        Your inquiry is sent to the LeadPilot n8n intake and stored in the connected HubSpot CRM for qualification and follow-up. If the form is unavailable, email{" "}
        <a href={`mailto:${CONTACT_EMAIL}?subject=Portfolio%20inquiry`}>{CONTACT_EMAIL}</a>.
      </p>
    </div>
  );
}

export default function LeadPilotH8() {
  const [target, setTarget] = useState(null);

  useEffect(() => {
    let observer;

    const attach = () => {
      const inquirySection = document.querySelector(".inquiry-form");
      if (!inquirySection) return false;
      document.body.classList.add("leadpilot-h8-enabled");
      setTarget(inquirySection);
      return true;
    };

    if (!attach()) {
      observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    }

    return () => {
      observer?.disconnect();
      document.body.classList.remove("leadpilot-h8-enabled");
    };
  }, []);

  return target ? createPortal(<LeadPilotInquiryForm />, target) : null;
}
