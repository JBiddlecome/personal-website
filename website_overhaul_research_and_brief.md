# Strategy & Technical Brief: Portfolio & Consulting Agency Overhaul

## 1. Executive Summary & Objective

### 1.1 Goal
Transform the existing personal portfolio website from a static resume into a **dual-purpose personal brand and technical consulting showcase**. The platform will position **Jake Biddlecome** as an end-to-end Senior Technical Programs Manager, Fractional CTO, and Full-Stack Systems Architect capable of rapidly engineering production-ready digital ecosystems from scratch.

### 1.2 Target Audience
*   **B2B Consulting Clients:** Founders, startups, and mid-market SMBs needing end-to-end cloud architecture, workflow automation, custom software, and technology stack optimization.
*   **Enterprise Recruiters / Hiring Managers:** Organizations looking for high-impact Senior Technical Program Managers, Engineering Managers, or Solutions Architects who deliver measurable results in tight timelines.

---

## 2. Business Model & Service Offerings

### 2.1 Micro-SaaS & B2B Consulting Alignment
Based on high-margin industry models (70%–95% gross margins with $0–$100 startup overhead), the consulting practice focuses on high-leverage service offerings:

1.  **End-to-End System Architecture & MVP Engineering:** Rapidly taking an idea from concept to full-stack deployment (Web, Mobile, Cloud, Infrastructure, Payments, Auth) in under 30 days.
2.  **Fractional Technical Management & Program Ownership:** Steering technical strategy, managing development pipelines, vendor evaluation, cost optimization, and DevOps setup.
3.  **B2B Workflow Automation & API Integration:** Connecting custom backend engines with third-party SaaS tools (Stripe, Xero, AWS, S3, Microsoft 365, Auth systems) to automate business operations.
4.  **Technology Stack & Infrastructure Audits:** Consulting on server choice, database ORM design, security compliance, scalability bottlenecks, and cloud cost containment.

---

## 3. Flagship Case Study: PRISM Talent Group (GoLive! Staffing Platform)

> **Headline Narrative:** *"Zero to Production in Under 30 Days: Engineering a Complete Enterprise Staffing Platform Single-Handedly."*

### 3.1 Overview
Built out the complete technical infrastructure, database architecture, backend APIs, mobile application foundation, financial integrations, and deployment pipelines for PRISM Talent Group (GoLive! Staffing) from scratch as a solo software architect and technical lead.

### 3.2 Technical Architecture & Ecosystem Map

#### Backend & Core Logic
*   **Framework:** FastAPI (Python) — Asynchronous, high-performance ASGI architecture.
*   **ORM & Data Layer:** SQLAlchemy with PostgreSQL (managed serverless via Neon / AWS Postgres).
*   **AI & Code Generation Integration:** Claude AI pipeline for automated operations and code generation workflows.
*   **Security & Auth:** Role-Based Access Control (RBAC), secure token-based authentication, and API security.

#### Frontend & Mobile Development
*   **Web Portal:** React / React Native Web.
*   **Mobile App:** React Native with Expo (Cross-platform iOS and Android).
*   **App Distribution:** Google Play Console & Apple Developer pipeline configuration.

#### Cloud Infrastructure & Storage
*   **Hosting & Deployment:** Railway platform / Render for containerized microservices and automated CI/CD.
*   **Object Storage:** AWS S3 / Cloud S2-compatible buckets for secure document and asset handling.
*   **Database Management:** Neon / AWS Postgres serverless instance management.

#### Operations, Payroll & Business SaaS Integrations
*   **Financial & Invoicing:** Stripe API integration for automated payments.
*   **Accounting & Payroll:** Xero API sync for bookkeeping and talent payout tracking.
*   **Enterprise Suite:** Microsoft 365 Business Basic workspace and license management.

---

## 4. Website Overhaul Strategy & Content Architecture

### 4.1 Page Layout & Navigation Structure

```
[ HEADER / NAV ]
  ├── Home / Hero (Consultant & Architect Persona)
  ├── Services & Capability Matrix
  ├── Case Study: PRISM Talent Group (Interactive Blueprint)
  ├── Work Experience & Resume
  └── Contact / Book Consultation Call

[ FOOTER ]
  └── GitHub | LinkedIn | Email | Schedule Strategy Call
```

### 4.2 Home / Hero Section
*   **Headline:** "I Build End-to-End Software Systems and Infrastructure in Record Time."
*   **Subheadline:** "Senior Technical Programs Manager & Systems Architect specializing in rapid full-stack application development, cloud infrastructure, and operational workflow automation."
*   **CTA Buttons:** `[ View System Architecture Case Study ]` | `[ Book a Technical Audit ]`

### 4.3 Service Matrix Section
*   **Card 1: Full-Stack MVP Engineering**
    *   *Deliverables:* FastAPI/Python backends, React/React Native frontends, PostgreSQL databases, mobile deployment.
*   **Card 2: Cloud & Infrastructure Deployment**
    *   *Deliverables:* Serverless DBs, AWS S3 buckets, Railway/Render hosting, containerization, security policies.
*   **Card 3: Business SaaS & API Integration**
    *   *Deliverables:* Stripe payments, Xero payroll/accounting pipelines, Microsoft 365 setup, third-party webhook logic.
*   **Card 4: Technical Program Management**
    *   *Deliverables:* Cost optimization, software selection, project pipeline management, developer tooling setup.

### 4.4 Case Study Showcase: "The 30-Day Enterprise Build"
An interactive breakdown showing potential clients the exact methodology used for PRISM Talent Group:
*   **Week 1:** Architectural planning, tech stack evaluation, cloud provisioning (Railway, S3, PostgreSQL).
*   **Week 2:** FastAPI backend setup, SQLAlchemy models, RBAC security, API schema definition.
*   **Week 3:** React Native mobile interface development, Expo configuration, Google Play setup.
*   **Week 4:** Financial integrations (Stripe, Xero), Microsoft 365 operational setup, production release.

### 4.5 Embedded Resume & Experience
Maintain traditional credibility for hiring managers:
*   **Senior Technical Programs Manager / Systems Architect** (Current)
*   **Project Manager & Operations Specialist** (Historical leadership & culinary/staffing domain experience)
*   **Skills Grid:** Python, FastAPI, React Native, SQLAlchemy, PostgreSQL, AWS S3, Railway, Stripe API, Xero API, CI/CD, System Design.

---

## 5. Technical Implementation Directives for Claude Code

When executing the overhaul of the website, Claude Code should follow these structural directives:

1.  **Repository Analysis:**
    *   Inspect `web-app` and `mobile-app` repositories to extract real, anonymized architecture diagrams, code patterns, and endpoint structures.
2.  **Visual Language & UI Polish:**
    *   Clean, dark-mode preferred tech aesthetic (monospaced accents, crisp typography, subtle grid borders).
    *   Interactive tech stack badges (Python, FastAPI, React Native, PostgreSQL, AWS, Stripe).
3.  **Interactive Elements:**
    *   An interactive "Architecture Visualizer" showing how backend, database, mobile app, and payment APIs interconnect.
    *   A "Consultation Estimator" or direct Calendly integration for booking strategy calls.
4.  **SEO & Messaging:**
    *   Optimize for terms: *Fractional Technical Program Manager*, *Full-Stack Python Engineer*, *React Native App Developer*, *FastAPI Cloud Architect*.

---

## 6. Document & Reference Metadata

*   **Author:** Jake Biddlecome
*   **Project Lead:** PRISM Talent Group / GoLive! Staffing Architecture
*   **Target Execution Date:** Immediate Overhaul
*   **Version:** 1.0 (Comprehensive Claude Code Brief)
