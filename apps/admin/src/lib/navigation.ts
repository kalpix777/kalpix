import type { Permission } from "./rbac";

export interface NavItem {
  slug: string;
  label: string;
  group: string;
  phase: number;
  icon: string; // lucide icon name
  description: string;
  permission?: Permission;
}

export const NAV: NavItem[] = [
  {
    slug: "",
    label: "Overview",
    group: "Workspace",
    phase: 2,
    icon: "LayoutDashboard",
    description: "Pipeline, revenue and system health at a glance.",
  },
  {
    slug: "discovery",
    label: "Business Discovery",
    group: "Acquire",
    phase: 3,
    icon: "MapPinned",
    description:
      "Find businesses by city, category and country through OpenStreetMap and licensed providers.",
  },
  {
    slug: "businesses",
    label: "Businesses",
    group: "Acquire",
    phase: 3,
    icon: "Building2",
    description: "Every discovered business with its source, date and confidence.",
  },
  {
    slug: "research",
    label: "Business Research",
    group: "Acquire",
    phase: 4,
    icon: "FileSearch",
    description:
      "Source-backed business profiles: every fact with its URL, date, confidence and verification status.",
  },
  {
    slug: "leads",
    label: "Leads",
    group: "Acquire",
    phase: 5,
    icon: "Target",
    description: "Scored and qualified businesses that need a better website.",
  },
  {
    slug: "crm",
    label: "CRM",
    group: "Acquire",
    phase: 6,
    icon: "Users",
    description: "Contacts, activities, tasks and approval requests.",
  },
  {
    slug: "generator",
    label: "Website Generator",
    group: "Build",
    phase: 8,
    icon: "Wand2",
    description: "Plan and generate personalised demos from verified business data.",
  },
  {
    slug: "templates",
    label: "Website Templates",
    group: "Build",
    phase: 7,
    icon: "LayoutTemplate",
    description:
      "Industry templates: restaurant, hospital, hotel, manufacturer, retail, real estate and more.",
  },
  {
    slug: "demos",
    label: "Demo Websites",
    group: "Build",
    phase: 9,
    icon: "MonitorSmartphone",
    description: "Preview, edit, approve or regenerate demos after automated QA.",
  },
  {
    slug: "deployments",
    label: "Deployments",
    group: "Build",
    phase: 10,
    icon: "Rocket",
    description: "Preview and production deployments with status and rollback.",
  },
  {
    slug: "enquiries",
    label: "Customer Enquiries",
    group: "Engage",
    phase: 12,
    icon: "Inbox",
    description: "Replies and enquiries from every channel in one queue.",
  },
  {
    slug: "whatsapp",
    label: "WhatsApp Operations",
    group: "Engage",
    phase: 11,
    icon: "MessageCircle",
    description: "Official WhatsApp Cloud API: templates, opt-ins, delivery and cost.",
  },
  {
    slug: "email",
    label: "Email Operations",
    group: "Engage",
    phase: 11,
    icon: "Mail",
    description: "Transactional and approved outreach email with delivery tracking.",
  },
  {
    slug: "sales",
    label: "Sales",
    group: "Revenue",
    phase: 2,
    icon: "BadgeIndianRupee",
    description: "Configurable service packages and pricing.",
    permission: "pricing:manage",
  },
  {
    slug: "quotations",
    label: "Quotations",
    group: "Revenue",
    phase: 13,
    icon: "FileText",
    description: "Quotes built from service packages, sent only after approval.",
  },
  {
    slug: "payments",
    label: "Payments",
    group: "Revenue",
    phase: 13,
    icon: "CreditCard",
    description:
      "Razorpay links and verified webhooks. Nothing is marked paid without confirmation.",
  },
  {
    slug: "invoices",
    label: "Invoices",
    group: "Revenue",
    phase: 13,
    icon: "Receipt",
    description: "GST-compliant invoices for advances and balances.",
  },
  {
    slug: "customer-websites",
    label: "Customer Websites",
    group: "Deliver",
    phase: 14,
    icon: "Globe",
    description: "Live customer sites, domains and hosting.",
  },
  {
    slug: "maintenance",
    label: "Maintenance",
    group: "Deliver",
    phase: 14,
    icon: "Wrench",
    description: "Subscriptions, update requests and uptime.",
  },
  {
    slug: "analytics",
    label: "Analytics",
    group: "Deliver",
    phase: 15,
    icon: "LineChart",
    description: "Revenue, CAC, margin, MRR and cost per lead or site.",
  },
  {
    slug: "providers",
    label: "AI Provider Settings",
    group: "System",
    phase: 2,
    icon: "Cpu",
    description: "Model and data providers: tier, key status, limits and fallbacks.",
    permission: "providers:manage",
  },
  {
    slug: "integrations",
    label: "Integrations",
    group: "System",
    phase: 2,
    icon: "Plug",
    description: "Every external service and whether it is configured.",
    permission: "providers:manage",
  },
  {
    slug: "users",
    label: "User Management",
    group: "System",
    phase: 2,
    icon: "UserCog",
    description: "Team members, roles and MFA status.",
    permission: "users:manage",
  },
  {
    slug: "audit",
    label: "Audit Logs",
    group: "System",
    phase: 2,
    icon: "ScrollText",
    description: "Every privileged and external action, who did it and when.",
    permission: "audit:read",
  },
  {
    slug: "settings",
    label: "System Settings",
    group: "System",
    phase: 2,
    icon: "Settings",
    description: "Agency profile, approvals and security.",
    permission: "settings:write",
  },
];

/** Highest phase whose modules are built. Modules above it show an honest "Not built yet". */
export const BUILT_THROUGH_PHASE = 3;

export const isBuilt = (n: Pick<NavItem, "phase">) => n.phase <= BUILT_THROUGH_PHASE;
