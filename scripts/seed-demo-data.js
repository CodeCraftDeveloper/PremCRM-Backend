import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url) });

import crypto from "crypto";
import dns from "dns";
import mongoose from "mongoose";

import Tenant from "../src/models/Tenant.js";
import TenantSettings from "../src/models/TenantSettings.js";
import User from "../src/models/User.js";
import UserSession from "../src/models/UserSession.js";
import Website from "../src/models/Website.js";
import Event from "../src/models/Event.js";
import TicketType from "../src/models/TicketType.js";
import CouponCode from "../src/models/CouponCode.js";
import EventRegistration from "../src/models/EventRegistration.js";
import Attendee from "../src/models/Attendee.js";
import Order from "../src/models/Order.js";
import Payment from "../src/models/Payment.js";
import Client from "../src/models/Client.js";
import Remark from "../src/models/Remark.js";
import Lead from "../src/models/Lead.js";
import LeadRemark from "../src/models/LeadRemark.js";
import LeadActivity from "../src/models/LeadActivity.js";
import Ticket from "../src/models/Ticket.js";
import TicketRemark from "../src/models/TicketRemark.js";
import Blog from "../src/models/Blog.js";
import ActivityLog from "../src/models/ActivityLog.js";
import AuditLog from "../src/models/AuditLog.js";
import UsageMetric from "../src/models/UsageMetric.js";
import FailedJob from "../src/models/FailedJob.js";
import IntegrationEvent from "../src/models/IntegrationEvent.js";
import Account from "../src/models/crm/Account.js";
import Contact from "../src/models/crm/Contact.js";
import Deal from "../src/models/crm/Deal.js";
import Pipeline from "../src/models/crm/Pipeline.js";
import CrmActivity from "../src/models/crm/CrmActivity.js";
import CustomField from "../src/models/crm/CustomField.js";
import ModuleLayout from "../src/models/crm/ModuleLayout.js";
import FormDefinition from "../src/models/crm/FormDefinition.js";
import AutomationRule from "../src/models/crm/AutomationRule.js";
import Workflow from "../src/models/Workflow.js";
import WorkflowRun from "../src/models/WorkflowRun.js";
import ChannelAccount from "../src/models/inbox/ChannelAccount.js";
import ContactIdentity from "../src/models/inbox/ContactIdentity.js";
import Conversation from "../src/models/inbox/Conversation.js";
import Message from "../src/models/inbox/Message.js";
import WhatsappTemplate from "../src/models/inbox/WhatsappTemplate.js";
import ApprovalRequest from "../src/models/ApprovalRequest.js";
import { PLATFORM_TENANT_SLUG } from "../src/utils/platformOwner.js";

const DEMO_PASSWORD = "Demo@Orbinest2026";
const DEMO_TENANT_SLUGS = [
  "orbinest-demo",
  "northstar-commerce",
  "apollo-events-archived",
];
const DEMO_EMAIL_DOMAIN = "orbinest.demo";

const now = new Date();
const argv = new Set(process.argv.slice(2));
const resetOnly = argv.has("--reset-only");

dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);

const daysAgo = (days, hour = 10) => {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  date.setHours(hour, 15, 0, 0);
  return date;
};

const daysFromNow = (days, hour = 10) => {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(hour, 15, 0, 0);
  return date;
};

const money = (base, spread, index) =>
  Math.round((base + ((index * 7919) % spread)) / 1000) * 1000;

const pick = (items, index) => items[index % items.length];

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const connect = async () => {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required in server/.env");
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    family: 4,
  });
};

const deleteTenantScopedData = async (tenantIds) => {
  if (!tenantIds.length) return;
  const tenantObjectIds = tenantIds.map((id) => new mongoose.Types.ObjectId(id));
  const tenantStrings = tenantIds.map(String);

  await Promise.all([
    ApprovalRequest.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Attendee.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    AuditLog.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    ActivityLog.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    AutomationRule.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Blog.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    ChannelAccount.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Client.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Contact.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    ContactIdentity.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Conversation.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    CouponCode.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    CrmActivity.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    CustomField.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Deal.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Event.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    EventRegistration.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    FailedJob.deleteMany({ tenantId: { $in: tenantStrings } }),
    FormDefinition.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    IntegrationEvent.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Lead.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    LeadActivity.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    LeadRemark.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Message.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    ModuleLayout.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Order.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Payment.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Pipeline.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Remark.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    TenantSettings.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Ticket.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    TicketRemark.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    TicketType.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    UsageMetric.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    User.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    UserSession.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Website.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    WhatsappTemplate.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    Workflow.deleteMany({ tenantId: { $in: tenantObjectIds } }),
    WorkflowRun.deleteMany({ tenantId: { $in: tenantObjectIds } }),
  ]);
};

const resetDemoData = async () => {
  const tenants = await Tenant.find({
    slug: { $in: [...DEMO_TENANT_SLUGS, PLATFORM_TENANT_SLUG] },
  }).select("_id slug");
  const demoTenantIds = tenants
    .filter((tenant) => tenant.slug !== PLATFORM_TENANT_SLUG)
    .map((tenant) => tenant._id);
  const platformTenant = tenants.find((tenant) => tenant.slug === PLATFORM_TENANT_SLUG);

  await deleteTenantScopedData(demoTenantIds);

  if (platformTenant) {
    await Promise.all([
      AuditLog.deleteMany({ tenantId: platformTenant._id }),
      ActivityLog.deleteMany({ tenantId: platformTenant._id }),
      UserSession.deleteMany({ tenantId: platformTenant._id }),
      UsageMetric.deleteMany({ tenantId: platformTenant._id }),
      User.deleteMany({
        tenantId: platformTenant._id,
        email: { $regex: `@${DEMO_EMAIL_DOMAIN}$` },
      }),
    ]);
  }

  await Tenant.deleteMany({ slug: { $in: DEMO_TENANT_SLUGS } });
};

const seedPlatform = async () => {
  const platformTenant = await Tenant.findOneAndUpdate(
    { slug: PLATFORM_TENANT_SLUG },
    {
      $set: {
        name: "Orbinest Platform Administration",
        company: { name: "Orbinest HQ" },
        plan: "enterprise",
        activeUsers: 1,
        isActive: true,
        lastActivityAt: daysAgo(0, 9),
        settings: { maxUsers: 500, maxEvents: 1000, timezone: "Asia/Kolkata" },
      },
    },
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );

  let superadmin = await User.findOne({
    tenantId: platformTenant._id,
    email: `owner@${DEMO_EMAIL_DOMAIN}`,
  }).select("+password");

  if (!superadmin) {
    superadmin = await User.findOne({ role: "superadmin" }).select("+password");
  }

  if (!superadmin) {
    superadmin = await User.create({
      tenantId: platformTenant._id,
      name: "Platform Owner",
      email: `owner@${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "superadmin",
      isActive: true,
      approvalStatus: "approved",
      lastLogin: daysAgo(0, 8),
    });
  } else {
    superadmin.tenantId = platformTenant._id;
    superadmin.name = "Platform Owner";
    superadmin.email = `owner@${DEMO_EMAIL_DOMAIN}`;
    superadmin.password = DEMO_PASSWORD;
    superadmin.role = "superadmin";
    superadmin.isActive = true;
    superadmin.approvalStatus = "approved";
    superadmin.lastLogin = daysAgo(0, 8);
    await superadmin.save();
  }

  return { platformTenant, superadmin };
};

const tenantConfigs = [
  {
    slug: "orbinest-demo",
    name: "PrismWorks Growth Studio",
    company: "PrismWorks Growth Studio Pvt Ltd",
    plan: "agency",
    isActive: true,
    maxUsers: 25,
    domainRoot: "prismworks",
    city: "Bengaluru",
    timezone: "Asia/Kolkata",
  },
  {
    slug: "northstar-commerce",
    name: "Northstar Commerce Cloud",
    company: "Northstar Retail Systems",
    plan: "growth",
    isActive: true,
    maxUsers: 12,
    domainRoot: "northstar",
    city: "Mumbai",
    timezone: "Asia/Kolkata",
  },
  {
    slug: "apollo-events-archived",
    name: "Apollo Events Archive",
    company: "Apollo Event Labs",
    plan: "starter",
    isActive: false,
    maxUsers: 6,
    domainRoot: "apolloevents",
    city: "Hyderabad",
    timezone: "Asia/Kolkata",
  },
];

const seedTenant = async (config, platformUser) => {
  const tenant = await Tenant.create({
    name: config.name,
    slug: config.slug,
    company: {
      name: config.company,
      logoUrl: `https://api.dicebear.com/9.x/shapes/svg?seed=${config.slug}`,
      referenceId: `TEN-${config.slug.toUpperCase().slice(0, 8)}`,
    },
    plan: config.plan,
    activeUsers: config.isActive ? config.maxUsers - 3 : 2,
    allowedRoles: ["admin", "marketing", "user"],
    subscription: {
      status: config.isActive ? "active" : "paused",
      billingCycleStart: daysAgo(18),
      billingCycleEnd: daysFromNow(12),
    },
    settings: {
      maxUsers: config.maxUsers,
      maxEvents: config.plan === "agency" ? 250 : 80,
      allowEmailSync: true,
      timezone: config.timezone,
      publicEventLanding: {
        heroImageUrl: `https://images.unsplash.com/photo-1556761175-b413da4baf72?auto=format&fit=crop&w=1600&q=80`,
        heroTagline: "Live sessions, buyer meetings, and growth operations in one workspace.",
        accentColor: "#2563eb",
      },
    },
    isActive: config.isActive,
    suspendedAt: config.isActive ? null : daysAgo(21),
    suspendedBy: config.isActive ? null : platformUser._id,
    suspendReason: config.isActive ? null : "Demo archived tenant for suspended-state QA.",
    lastActivityAt: config.isActive ? daysAgo(0, 11) : daysAgo(16),
    createdAt: daysAgo(config.isActive ? 95 : 220),
    updatedAt: daysAgo(config.isActive ? 0 : 16),
  });

  const users = await User.create([
    {
      tenantId: tenant._id,
      name: "Anika Rao",
      email: `admin@${config.slug}.${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "admin",
      phone: "+91 98765 41001",
      avatar: "https://api.dicebear.com/9.x/initials/svg?seed=Anika%20Rao",
      isActive: true,
      approvalStatus: "approved",
      approvedBy: platformUser._id,
      approvedAt: daysAgo(94),
      lastLogin: daysAgo(0, 9),
      createdAt: daysAgo(95),
      updatedAt: daysAgo(0),
    },
    {
      tenantId: tenant._id,
      name: "Rohan Mehta",
      email: `rohan@${config.slug}.${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "marketing",
      phone: "+91 98765 41002",
      avatar: "https://api.dicebear.com/9.x/initials/svg?seed=Rohan%20Mehta",
      isActive: true,
      approvalStatus: "approved",
      lastLogin: daysAgo(0, 10),
      createdAt: daysAgo(86),
      updatedAt: daysAgo(0),
    },
    {
      tenantId: tenant._id,
      name: "Meera Iyer",
      email: `meera@${config.slug}.${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "marketing",
      phone: "+91 98765 41003",
      avatar: "https://api.dicebear.com/9.x/initials/svg?seed=Meera%20Iyer",
      isActive: true,
      approvalStatus: "approved",
      lastLogin: daysAgo(1, 17),
      createdAt: daysAgo(72),
      updatedAt: daysAgo(1),
    },
    {
      tenantId: tenant._id,
      name: "Kabir Sethi",
      email: `kabir@${config.slug}.${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "marketing",
      phone: "+91 98765 41004",
      avatar: null,
      isActive: true,
      approvalStatus: "approved",
      lastLogin: daysAgo(7, 14),
      createdAt: daysAgo(61),
      updatedAt: daysAgo(7),
    },
    {
      tenantId: tenant._id,
      name: "Nisha Fernandes",
      email: `pending@${config.slug}.${DEMO_EMAIL_DOMAIN}`,
      password: DEMO_PASSWORD,
      role: "marketing",
      phone: "+91 98765 41005",
      isActive: false,
      approvalStatus: "pending",
      lastLogin: null,
      createdAt: daysAgo(3),
      updatedAt: daysAgo(3),
    },
  ]);

  const [admin, rohan, meera, kabir] = users;
  const marketers = [rohan, meera, kabir];

  await TenantSettings.create({
    tenantId: tenant._id,
    leadStatusPipeline: ["new", "contacted", "interested", "qualified", "closed", "lost"],
    customFields: {
      lead: [
        { key: "budget_range", label: "Budget Range", type: "select", options: ["<5L", "5L-25L", "25L+"], required: false },
        { key: "urgency", label: "Urgency", type: "select", options: ["This week", "This month", "Quarter"], required: false },
      ],
      client: [
        { key: "renewal_window", label: "Renewal Window", type: "date", required: false },
        { key: "decision_committee", label: "Decision Committee", type: "number", required: false },
      ],
    },
    sla: { firstResponseTime: 4, followUpInterval: 36, maxIdleDays: 5 },
    assignmentRules: { method: "least_loaded", autoAssignNewLeads: true, maxLeadsPerUser: 80 },
    features: {
      advancedAnalytics: true,
      workflows: true,
      exports: true,
      leadScoring: true,
      duplicateDetection: true,
      customFields: true,
      apiAccess: true,
    },
  });

  const websites = await Website.create([
    {
      tenantId: tenant._id,
      name: "Main Product Website",
      domain: `${config.domainRoot}.co`,
      apiKey: crypto.randomBytes(32).toString("hex"),
      apiKeyPrefix: `${config.domainRoot.slice(0, 4)}_main`,
      description: "Primary website contact and demo request forms.",
      category: "contact_form",
      stats: { totalLeads: 0, leadsThisMonth: 0, duplicatesDetected: 0, lastLeadAt: daysAgo(0, 12) },
      products: ["CRM implementation", "Event operations", "Inbox automation", "Revenue analytics"],
      formFields: [
        { fieldName: "team_size", label: "Team Size", type: "select", options: ["1-10", "11-50", "51-200", "200+"], sortOrder: 1, isActive: true },
        { fieldName: "timeline", label: "Buying Timeline", type: "select", options: ["Immediate", "30 days", "This quarter"], sortOrder: 2, isActive: true },
      ],
      formConfig: {
        formTitle: "Talk to growth operations",
        formDescription: "Tell us what workflow is slowing your team down.",
        submitButtonText: "Request a walkthrough",
        successMessage: "Thanks. A specialist will contact you shortly.",
        defaultFields: { city: { show: true, required: false, label: "City" }, country: { show: true, required: false, label: "Country" } },
      },
      blogConfig: {},
      isActive: true,
      createdBy: admin._id,
      createdAt: daysAgo(92),
      updatedAt: daysAgo(0),
    },
    {
      tenantId: tenant._id,
      name: "Webinar Landing Pages",
      domain: `events.${config.domainRoot}.co`,
      apiKey: crypto.randomBytes(32).toString("hex"),
      apiKeyPrefix: `${config.domainRoot.slice(0, 4)}_evt`,
      description: "Campaign-specific landing pages and gated webinar forms.",
      category: "webinar",
      products: ["CRO audit", "Lead capture", "WhatsApp nurture"],
      isActive: true,
      createdBy: admin._id,
      createdAt: daysAgo(70),
      updatedAt: daysAgo(2),
    },
  ]);

  const eventSpecs = [
    ["Revenue Leaders Roundtable 2026", "Bengaluru International Centre", -22, -21, 220, 650000, ["roundtable", "enterprise"], "completed"],
    ["D2C Growth Clinic", "Taj Lands End, Mumbai", -2, 1, 180, 380000, ["d2c", "workshop"], "active"],
    ["Automation Demo Day", "Online", 16, 16, 420, 190000, ["webinar", "automation"], "upcoming"],
    ["Partner Enablement Summit", "Hyderabad HICC", 45, 46, 300, 520000, ["partner", "summit"], "upcoming"],
    ["Legacy Campaign Cleanup", "Archived Venue", -130, -129, 90, 120000, ["archive"], "cancelled"],
  ];

  const events = [];
  for (const [name, location, startOffset, endOffset, targetLeads, budget, tags, status] of eventSpecs) {
    events.push(await Event.create({
      tenantId: tenant._id,
      name,
      description: `${name} focused on pipeline health, buyer conversations, and measurable follow-up operations.`,
      location,
      startDate: daysFromNow(startOffset, 9),
      endDate: daysFromNow(endOffset, 18),
      status,
      targetLeads,
      budget,
      tags,
      image: `https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1400&q=80&sig=${slugify(name)}`,
      landing: {
        heroImageUrl: "https://images.unsplash.com/photo-1505373877841-8d25f7d46678?auto=format&fit=crop&w=1600&q=80",
        heroTagline: "Meet operators, founders, and revenue leaders in one focused room.",
        accentColor: "#0f766e",
      },
      registrationFields: [
        { key: "role", label: "Role", type: "select", required: true, options: ["Founder", "Sales Leader", "Marketing Leader", "Operations"], sortOrder: 1 },
        { key: "primary_goal", label: "Primary goal", type: "textarea", required: false, sortOrder: 2, maxLength: 400 },
      ],
      createdBy: admin._id,
      assignedUsers: marketers.map((user) => user._id),
      createdAt: daysAgo(Math.max(7, Math.abs(startOffset) + 35)),
      updatedAt: daysAgo(1),
    }));
  }

  const ticketTypes = [];
  for (const event of events.slice(0, 4)) {
    ticketTypes.push(
      ...(await TicketType.create([
        {
          tenantId: tenant._id,
          eventId: event._id,
          name: "General Access",
          description: "Entry, sessions, networking area, and digital resources.",
          price: 2499,
          capacity: 160,
          sold: event.status === "completed" ? 138 : event.status === "active" ? 72 : 18,
          status: "active",
          saleStartDate: daysAgo(60),
          saleEndDate: event.startDate,
        },
        {
          tenantId: tenant._id,
          eventId: event._id,
          name: "VIP Buyer Table",
          description: "Reserved seating, buyer-introduction desk, and private dinner access.",
          price: 14999,
          capacity: 24,
          sold: event.status === "completed" ? 24 : event.status === "active" ? 19 : 6,
          status: event.status === "completed" ? "sold_out" : "active",
          waitlistEnabled: true,
          saleStartDate: daysAgo(55),
          saleEndDate: event.startDate,
        },
      ]))
    );
  }

  const coupons = await CouponCode.create(events.slice(0, 3).map((event, index) => ({
    tenantId: tenant._id,
    eventId: event._id,
    code: index === 0 ? "FOUNDERS20" : index === 1 ? "VIPFAST10" : "WEBINARFREE",
    description: "Demo campaign coupon with usage history.",
    discountType: index === 2 ? "fixed" : "percentage",
    discountValue: index === 2 ? 2499 : index === 0 ? 20 : 10,
    maxDiscountAmount: index === 0 ? 3000 : null,
    maxUses: 80,
    usedCount: 12 + index * 9,
    startsAt: daysAgo(45),
    endsAt: daysFromNow(30),
    isActive: true,
  })));

  const accounts = await Account.create([
    "KiranaKart Retail",
    "Veda Foods Collective",
    "BluePeak Logistics",
    "Urban Loom Studio",
    "FinEdge Advisory",
    "Saffron Staycations",
    "HelioMed Devices",
    "StackLane SaaS",
    "Long Company Name Designed To Test Responsive Table Overflow Private Limited",
    "Dormant Prospect Holdings",
  ].map((name, index) => ({
    tenantId: tenant._id,
    name,
    industry: pick(["Retail", "Food & Beverage", "Logistics", "SaaS", "Healthcare", "Hospitality"], index),
    website: `https://${slugify(name)}.example.com`,
    phone: `+91 80${String(40000000 + index * 17329).slice(0, 8)}`,
    email: `ops@${slugify(name)}.example.com`,
    annualRevenue: money(18000000, 95000000, index),
    numberOfEmployees: 25 + index * 41,
    type: pick(["prospect", "customer", "partner", "vendor"], index),
    ownerId: pick(marketers, index)._id,
    billingAddress: { city: pick(["Bengaluru", "Mumbai", "Pune", "Delhi", "Chennai"], index), state: pick(["Karnataka", "Maharashtra", "Delhi", "Tamil Nadu"], index), country: "India", zipCode: `5600${index}` },
    tags: [pick(["enterprise", "mid-market", "high-intent", "renewal", "partner"], index)],
    customData: { cf_account_health: pick(["green", "amber", "red"], index), cf_region: pick(["south", "west", "north"], index) },
    searchIndex: { cf_account_health: pick(["green", "amber", "red"], index) },
    createdAt: daysAgo(80 - index * 3),
    updatedAt: daysAgo(index % 9),
  })));

  const contacts = await Contact.create(accounts.flatMap((account, accountIndex) =>
    [0, 1].map((contactIndex) => {
      const owner = pick(marketers, accountIndex + contactIndex);
      const firstName = pick(["Aarav", "Diya", "Ishaan", "Tara", "Vivaan", "Sana", "Advait", "Kiara", "Reyansh", "Myra"], accountIndex * 2 + contactIndex);
      const lastName = pick(["Kapoor", "Shah", "Nair", "Menon", "Gupta", "Bose", "Reddy", "Bhatia"], accountIndex + contactIndex);
      return {
        tenantId: tenant._id,
        firstName,
        lastName,
        email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@${slugify(account.name)}.example.com`,
        phone: `+91 9${String(100000000 + accountIndex * 11111 + contactIndex * 2222).slice(0, 9)}`,
        title: pick(["Founder", "Revenue Head", "Marketing Director", "Operations Lead", "Procurement Manager"], accountIndex + contactIndex),
        department: pick(["Leadership", "Revenue", "Marketing", "Operations"], contactIndex),
        accountId: account._id,
        ownerId: owner._id,
        source: pick(["event", "website", "referral", "email_campaign", "lead_conversion"], accountIndex),
        address: account.billingAddress,
        tags: [pick(["decision-maker", "influencer", "technical-buyer"], contactIndex)],
        createdAt: daysAgo(76 - accountIndex * 3 - contactIndex),
        updatedAt: daysAgo((accountIndex + contactIndex) % 8),
      };
    })
  ));

  const pipeline = await Pipeline.create({
    tenantId: tenant._id,
    name: "Enterprise Revenue Pipeline",
    isDefault: true,
    isActive: true,
    stages: [
      { name: "Qualification", probability: 10, order: 0 },
      { name: "Discovery", probability: 25, order: 1 },
      { name: "Solution Fit", probability: 45, order: 2 },
      { name: "Commercial Review", probability: 70, order: 3 },
      { name: "Closed Won", probability: 100, order: 4, isClosed: true, isWon: true },
      { name: "Closed Lost", probability: 0, order: 5, isClosed: true, isWon: false },
    ],
    createdAt: daysAgo(84),
    updatedAt: daysAgo(2),
  });

  const dealStages = pipeline.stages.map((stage) => stage.name);
  const deals = await Deal.create(accounts.map((account, index) => {
    const stage = pick(dealStages, index);
    const won = stage === "Closed Won";
    const lost = stage === "Closed Lost";
    const owner = pick(marketers, index);
    return {
      tenantId: tenant._id,
      name: `${account.name} - ${pick(["CRM rollout", "Event automation", "Inbox operations", "Analytics workspace"], index)}`,
      amount: money(350000, 4200000, index),
      closingDate: lost ? daysAgo(6) : daysFromNow(7 + index * 5),
      pipelineId: pipeline._id,
      stage,
      probability: pipeline.stages.find((item) => item.name === stage)?.probability || 10,
      contactId: contacts[index * 2]?._id,
      accountId: account._id,
      ownerId: owner._id,
      source: pick(["event", "website", "referral", "email_campaign"], index),
      type: pick(["new_business", "existing_business", "renewal"], index),
      wonAt: won ? daysAgo(index + 3) : null,
      lostAt: lost ? daysAgo(index + 4) : null,
      lostReason: lost ? pick(["Budget frozen", "Chose incumbent vendor", "Timeline pushed to next year"], index) : "",
      stageHistory: [
        { stage: "Qualification", enteredAt: daysAgo(45 - index), exitedAt: daysAgo(38 - index), durationMs: 7 * 86400000, movedBy: owner._id },
        { stage, enteredAt: daysAgo(20 - index), exitedAt: won || lost ? daysAgo(index + 3) : null, durationMs: (12 + index) * 86400000, movedBy: owner._id },
      ],
      description: "Seeded opportunity with realistic stage history and owner assignment.",
      tags: [pick(["expansion", "q2-commit", "board-visible", "price-sensitive"], index)],
      customData: { cf_competitor: pick(["HubSpot", "Zoho", "Spreadsheet", "None"], index), cf_buying_committee: 2 + (index % 5) },
      searchIndex: { cf_competitor: pick(["HubSpot", "Zoho", "Spreadsheet", "None"], index) },
      createdAt: daysAgo(55 - index * 2),
      updatedAt: daysAgo(index % 6),
    };
  }));

  const leadNames = [
    ["Priya", "Sharma", "BrightCart", "Retail"],
    ["Arjun", "Patel", "NimbleFleet", "Logistics"],
    ["Neha", "Singh", "Bloom & Brew", "Food"],
    ["Farhan", "Khan", "ClinicPlus", "Healthcare"],
    ["Ira", "Das", "EduBridge", "Education"],
    ["Samar", "Roy", "QuickLedger", "Finance"],
    ["Lavanya", "Rao", "EcoHome", "Real Estate"],
    ["Dev", "Malhotra", "NovaFit", "Wellness"],
    ["Anaya", "Joshi", "PixelCraft", "Agency"],
    ["Kunal", "Verma", "RouteMax", "Transport"],
    ["Pooja", "Bansal", "FreshBasket", "Grocery"],
    ["Zoya", "Ali", "CloudTutor", "EdTech"],
  ];

  const leads = await Lead.create(Array.from({ length: config.isActive ? 72 : 18 }, (_, index) => {
    const [firstName, lastName, company, industry] = pick(leadNames, index);
    const assignedTo = index % 9 === 0 ? null : pick(marketers, index)._id;
    const status = pick(["new", "contacted", "interested", "qualified", "closed", "lost"], index + (index % 4));
    const createdAt = daysAgo(index % 60, 9 + (index % 8));
    const isConverted = status === "closed" || index % 11 === 0;
    return {
      tenantId: tenant._id,
      firstName: `${firstName}${index >= leadNames.length ? index : ""}`,
      lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index}@${slugify(company)}.example.com`,
      phone: `+91 8${String(900000000 + index * 9271).slice(0, 9)}`,
      message: pick([
        "We need to centralize inquiries from events, WhatsApp, and website forms before next quarter.",
        "Looking for a CRM with better follow-up visibility and approval-based outbound messaging.",
        "Can your team help us automate demo reminders and post-event nurture?",
      ], index),
      websiteId: pick(websites, index)._id,
      source: pick(["contact_form", "landing_page", "webinar", "partner", "api"], index),
      status,
      score: Math.min(100, 22 + ((index * 13) % 78)),
      assignedTo,
      assignedAt: assignedTo ? daysAgo((index % 30) + 1) : null,
      isDuplicate: index === 10 || index === 37,
      ipAddress: `103.21.${index % 255}.${40 + index}`,
      userAgent: pick(["Chrome on Windows", "Safari on iPhone", "Edge on Windows", "Chrome on Android"], index),
      country: "India",
      city: pick(["Bengaluru", "Mumbai", "Delhi", "Pune", "Hyderabad", "Chennai"], index),
      state: pick(["Karnataka", "Maharashtra", "Delhi", "Telangana", "Tamil Nadu"], index),
      company,
      productInterest: pick(["CRM implementation", "Inbox automation", "Event operations", "Revenue analytics"], index),
      customFields: { industry, budgetRange: pick(["5L-25L", "25L+", "<5L"], index), urgency: pick(["This week", "This month", "Quarter"], index) },
      customData: { cf_intent: pick(["high", "medium", "low"], index), cf_campaign: pick(["q2-webinar", "partner-referral", "organic"], index) },
      searchIndex: { cf_intent: pick(["high", "medium", "low"], index), cf_campaign: pick(["q2-webinar", "partner-referral", "organic"], index) },
      lastContactedAt: index % 5 === 0 ? null : daysAgo(index % 12),
      nextFollowUpDate: status === "lost" || isConverted ? null : daysFromNow((index % 9) - 3, 11),
      contactAttempts: index % 6,
      isConverted,
      convertedAt: isConverted ? daysAgo(index % 15) : null,
      conversionValue: isConverted ? money(180000, 850000, index) : 0,
      tags: [pick(["hot", "event", "enterprise", "duplicate-check", "nurture"], index)],
      notes: index % 8 === 0 ? "Long note used for detail view wrapping and mobile layout checks. Buyer asked for compliance review, multiple approvers, and a phased rollout plan." : "",
      attachments: index % 13 === 0 ? [{
        fileName: `requirements-${index}.pdf`,
        originalName: "Workflow Requirements.pdf",
        mimeType: "application/pdf",
        size: 184000 + index,
        url: `/uploads/lead-attachments/demo/requirements-${index}.pdf`,
        uploadedBy: assignedTo || admin._id,
        uploadedAt: daysAgo(index % 10),
      }] : [],
      lastActivityAt: daysAgo(index % 7),
      deletedAt: index === 21 ? daysAgo(2) : null,
      deletedBy: index === 21 ? admin._id : null,
      createdAt,
      updatedAt: daysAgo(index % 5),
    };
  }));

  const primaryLead = leads[0];
  await Lead.updateMany(
    { tenantId: tenant._id, isDuplicate: true },
    { duplicateOf: primaryLead._id },
  );

  await Website.updateOne(
    { _id: websites[0]._id },
    {
      $set: {
        "stats.totalLeads": leads.filter((lead) => String(lead.websiteId) === String(websites[0]._id)).length,
        "stats.leadsThisMonth": leads.filter((lead) => String(lead.websiteId) === String(websites[0]._id) && lead.createdAt > daysAgo(30)).length,
        "stats.duplicatesDetected": 2,
        "stats.lastLeadAt": daysAgo(0, 12),
      },
    },
  );

  const clients = await Client.create(Array.from({ length: config.isActive ? 54 : 10 }, (_, index) => {
    const account = pick(accounts, index);
    const owner = pick(marketers, index);
    const status = pick(["new", "contacted", "interested", "negotiation", "converted", "lost"], index + 1);
    return {
      tenantId: tenant._id,
      name: contacts[index % contacts.length].fullName || `${contacts[index % contacts.length].firstName} ${contacts[index % contacts.length].lastName}`,
      companyName: account.name,
      email: contacts[index % contacts.length].email,
      phone: contacts[index % contacts.length].phone,
      alternatePhone: index % 7 === 0 ? "" : `+91 7${String(800000000 + index * 131).slice(0, 9)}`,
      address: { street: `${12 + index}, Business Park Road`, city: pick(["Bengaluru", "Mumbai", "Delhi", "Pune"], index), state: pick(["Karnataka", "Maharashtra", "Delhi"], index), country: "India", pincode: `560${String(100 + index).slice(0, 3)}` },
      event: pick(events, index)._id,
      marketingPerson: owner._id,
      createdBy: admin._id,
      followUpStatus: status,
      priority: pick(["low", "medium", "high", "urgent"], index),
      nextFollowUpDate: ["converted", "lost"].includes(status) ? null : daysFromNow((index % 12) - 5, 10),
      lastContactedDate: daysAgo(index % 14),
      lastContactedBy: owner._id,
      industry: account.industry,
      designation: contacts[index % contacts.length].title,
      source: pick(["event", "referral", "website", "cold_call", "email", "social_media"], index),
      estimatedValue: money(90000, 1800000, index),
      visitingCard: index % 6 === 0 ? { url: `/uploads/visiting-cards/demo/card-${index}.jpg`, key: `demo/card-${index}.jpg`, uploadedAt: daysAgo(index % 20) } : {},
      notes: pick(["Asked for executive summary before commercial call.", "Needs integration proof for WhatsApp and Gmail.", "Procurement wants itemized rollout plan.", "No response after first call; nurture later."], index),
      tags: [pick(["vip", "field-event", "warm", "needs-demo", "renewal"], index)],
      isActive: index !== 17,
      convertedDate: status === "converted" ? daysAgo(index % 18) : null,
      deletedAt: index === 17 ? daysAgo(4) : null,
      deletedBy: index === 17 ? admin._id : null,
      createdAt: daysAgo(index % 75),
      updatedAt: daysAgo(index % 6),
    };
  }));

  const remarks = [];
  for (const client of clients.slice(0, 30)) {
    remarks.push({
      tenantId: tenant._id,
      client: client._id,
      user: client.marketingPerson,
      content: "Discovery call completed. Buyer confirmed current process is split across spreadsheets, shared inbox, and manual WhatsApp follow-ups.",
      type: "call",
      isPinned: client.priority === "urgent",
      createdAt: daysAgo(Math.floor(Math.random() * 20)),
      updatedAt: daysAgo(0),
    });
    remarks.push({
      tenantId: tenant._id,
      client: client._id,
      user: admin._id,
      content: `Status changed to ${client.followUpStatus} after latest activity.`,
      type: "status_change",
      previousStatus: "contacted",
      newStatus: client.followUpStatus,
      isInternal: true,
      createdAt: daysAgo(Math.floor(Math.random() * 10)),
      updatedAt: daysAgo(0),
    });
  }
  await Remark.insertMany(remarks);

  await LeadRemark.insertMany(leads.slice(0, 36).flatMap((lead, index) => [
    {
      tenantId: tenant._id,
      lead: lead._id,
      user: lead.assignedTo || admin._id,
      content: pick(["Initial qualification complete.", "Buyer requested a pricing benchmark.", "Duplicate suspected from same company domain.", "Follow-up scheduled with operations lead."], index),
      type: pick(["note", "call", "email", "follow_up"], index),
      isPinned: index % 12 === 0,
      createdAt: daysAgo(index % 18),
      updatedAt: daysAgo(index % 4),
    },
  ]));

  await LeadActivity.insertMany(leads.slice(0, 30).map((lead, index) => ({
    tenantId: tenant._id,
    leadId: lead._id,
    performedBy: lead.assignedTo || admin._id,
    performedByName: lead.assignedTo
      ? marketers.find((user) => String(user._id) === String(lead.assignedTo))?.name || "Marketing User"
      : admin.name,
    action: pick(["created", "assigned", "status_changed", "note_added", "contacted"], index),
    description: pick(["Lead captured from website.", "Lead assigned by automation rule.", "Status updated during QA flow.", "Remark added by owner.", "Nurture email sent."], index),
    metadata: { demo: true, score: lead.score },
    createdAt: daysAgo(index % 14),
    updatedAt: daysAgo(index % 4),
  })));

  for (let index = 0; index < Math.min(12, leads.length, contacts.length, accounts.length, deals.length); index += 1) {
    const lead = leads[index];
    if (!lead.isConverted) continue;
    await Lead.updateOne(
      { _id: lead._id },
      {
        convertedToContactId: contacts[index]._id,
        convertedToAccountId: accounts[index % accounts.length]._id,
        convertedToDealId: deals[index % deals.length]._id,
      },
    );
  }

  await CustomField.insertMany([
    {
      tenantId: tenant._id,
      moduleApiName: "leads",
      label: "Intent Band",
      apiName: "cf_intent_band",
      fieldType: "select",
      options: [
        { label: "High", value: "high", color: "#ef4444" },
        { label: "Medium", value: "medium", color: "#f59e0b" },
        { label: "Low", value: "low", color: "#64748b" },
      ],
      isFilterable: true,
      isSearchable: true,
      isIndexed: true,
      createdBy: admin._id,
    },
    {
      tenantId: tenant._id,
      moduleApiName: "deals",
      label: "Buying Committee Size",
      apiName: "cf_buying_committee",
      fieldType: "number",
      numberConfig: { min: 1, max: 12, precision: 0 },
      isVisibleInList: true,
      isFilterable: true,
      createdBy: admin._id,
    },
    {
      tenantId: tenant._id,
      moduleApiName: "accounts",
      label: "Account Health",
      apiName: "cf_account_health",
      fieldType: "select",
      options: [
        { label: "Green", value: "green", color: "#22c55e" },
        { label: "Amber", value: "amber", color: "#f59e0b" },
        { label: "Red", value: "red", color: "#ef4444" },
      ],
      isVisibleInList: true,
      isFilterable: true,
      createdBy: admin._id,
    },
  ]);

  await ModuleLayout.insertMany(["leads", "contacts", "accounts", "deals"].flatMap((moduleApiName) => [
    {
      tenantId: tenant._id,
      moduleApiName,
      layoutType: "list",
      listColumns: ["name", "fullName", "email", "phone", "stage", "amount", "ownerId"].map((fieldApiName, index) => ({ fieldApiName, width: index === 0 ? 240 : null, sortable: true })),
      createdBy: admin._id,
      updatedBy: admin._id,
    },
    {
      tenantId: tenant._id,
      moduleApiName,
      layoutType: "detail",
      sections: [
        { title: "Overview", columns: 2, fields: ["name", "fullName", "email", "phone", "ownerId"], sortOrder: 1 },
        { title: "Commercial Context", columns: 2, fields: ["amount", "stage", "source", "tags"], sortOrder: 2 },
      ],
      createdBy: admin._id,
      updatedBy: admin._id,
    },
  ]));

  await FormDefinition.create({
    tenantId: tenant._id,
    name: "Enterprise Demo Request",
    apiName: "enterprise_demo_request",
    description: "Public CRM form for enterprise demo requests.",
    moduleApiName: "leads",
    formType: "public",
    fieldMappings: [
      { label: "First Name", fieldApiName: "firstName", isRequired: true, sortOrder: 1 },
      { label: "Email", fieldApiName: "email", isRequired: true, sortOrder: 2 },
      { label: "Company", fieldApiName: "company", isRequired: true, sortOrder: 3 },
      { label: "Intent Band", fieldApiName: "cf_intent_band", overrideType: "select", sortOrder: 4 },
    ],
    settings: {
      submitLabel: "Book my demo",
      successMessage: "Your demo request is in. We will reply with slots shortly.",
      defaultOwnerId: rohan._id,
      notifyUsers: [admin._id, rohan._id],
      theme: "orbinest",
    },
    submissionCount: 46,
    lastSubmissionAt: daysAgo(0, 12),
    createdBy: admin._id,
  });

  const registrations = [];
  const attendees = [];
  const orders = [];
  const payments = [];
  for (let index = 0; index < (config.isActive ? 80 : 12); index += 1) {
    const event = pick(events.slice(0, 3), index);
    const type = ticketTypes.find((item) => String(item.eventId) === String(event._id)) || ticketTypes[0];
    const contact = pick(contacts, index);
    const quantity = 1 + (index % 3 === 0 ? 1 : 0);
    const subtotal = type.price * quantity;
    const coupon = index % 6 === 0 ? pick(coupons, index) : null;
    const discount = coupon ? Math.min(3000, Math.round(subtotal * 0.15)) : 0;
    const total = Math.max(0, subtotal - discount);
    const paymentStatus = pick(["paid", "paid", "paid", "pending", "failed", "refunded"], index);
    const status = paymentStatus === "failed" ? "pending" : paymentStatus === "refunded" ? "cancelled" : pick(["confirmed", "confirmed", "checked_in", "no_show"], index);
    const attendee = {
      tenantId: tenant._id,
      eventId: event._id,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email.replace("@", `+event${index}@`),
      phone: contact.phone,
      company: accounts[index % accounts.length].name,
      createdAt: daysAgo(index % 35),
      updatedAt: daysAgo(index % 5),
    };
    attendees.push(attendee);
    registrations.push({
      tenantId: tenant._id,
      eventId: event._id,
      ticketTypeId: type._id,
      registrationNumber: `REG-DEMO-${config.slug.toUpperCase().slice(0, 4)}-${String(index + 1).padStart(5, "0")}`,
      attendee: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        phone: contact.phone,
        company: accounts[index % accounts.length].name,
      },
      quantity,
      subtotalAmount: subtotal,
      discountAmount: discount,
      totalAmount: total,
      currency: "INR",
      status,
      paymentStatus,
      couponCodeId: coupon?._id || null,
      couponCode: coupon?.code || null,
      paymentReference: paymentStatus === "paid" ? `pay_demo_${index}` : null,
      qrToken: crypto
        .createHash("sha256")
        .update(`${config.slug}-registration-${index}`)
        .digest("hex"),
      checkedInAt: status === "checked_in" ? daysAgo(index % 5, 10) : null,
      checkedInBy: status === "checked_in" ? pick(marketers, index)._id : null,
      notes: index % 10 === 0 ? "Dietary preference and badge-printing edge case." : "",
      customFields: { role: contact.title, primary_goal: pick(["Networking", "Vendor evaluation", "Learning", "Partnership"], index) },
      source: pick(["web", "admin", "api"], index),
      createdAt: daysAgo(index % 42),
      updatedAt: daysAgo(index % 5),
    });
  }
  const insertedAttendees = await Attendee.insertMany(attendees);
  const insertedRegistrations = await EventRegistration.insertMany(registrations);
  for (let index = 0; index < insertedRegistrations.length; index += 1) {
    const registration = insertedRegistrations[index];
    orders.push({
      tenantId: tenant._id,
      eventId: registration.eventId,
      attendeeId: insertedAttendees[index]._id,
      orderNumber: `ORD-DEMO-${config.slug.toUpperCase().slice(0, 4)}-${String(index + 1).padStart(5, "0")}`,
      status: registration.status === "cancelled" ? "cancelled" : registration.paymentStatus === "pending" ? "pending" : "confirmed",
      subtotalAmount: registration.subtotalAmount,
      discountAmount: registration.discountAmount,
      totalAmount: registration.totalAmount,
      currency: registration.currency,
      couponCodeId: registration.couponCodeId,
      couponCode: registration.couponCode,
      source: registration.source,
      notes: "Generated from demo registration seed.",
      createdAt: registration.createdAt,
      updatedAt: registration.updatedAt,
    });
  }
  const insertedOrders = await Order.insertMany(orders);
  for (let index = 0; index < insertedOrders.length; index += 1) {
    const order = insertedOrders[index];
    const registration = insertedRegistrations[index];
    payments.push({
      tenantId: tenant._id,
      eventId: order.eventId,
      orderId: order._id,
      amount: order.totalAmount,
      currency: order.currency,
      status: registration.paymentStatus,
      method: registration.totalAmount === 0 ? "free" : pick(["card", "upi", "bank_transfer", "cash"], index),
      provider: registration.totalAmount === 0 ? "free" : pick(["razorpay", "stripe", "manual"], index),
      transactionId: registration.paymentStatus === "paid" ? `txn_demo_${config.slug}_${index}` : null,
      paidAt: registration.paymentStatus === "paid" ? registration.createdAt : null,
      refundedAt: registration.paymentStatus === "refunded" ? daysAgo(index % 8) : null,
      refundAmount: registration.paymentStatus === "refunded" ? Math.round(order.totalAmount * 0.8) : 0,
      failureReason: registration.paymentStatus === "failed" ? pick(["Bank declined UPI collect", "Card authentication failed", "Payment window expired"], index) : "",
      createdAt: registration.createdAt,
      updatedAt: registration.updatedAt,
    });
  }
  await Payment.insertMany(payments);

  const tickets = await Ticket.create(Array.from({ length: config.isActive ? 36 : 6 }, (_, index) => {
    const relatedLead = pick(leads, index);
    const owner = pick(marketers, index);
    const status = pick(["open", "in_progress", "waiting_on_customer", "waiting_on_third_party", "resolved", "closed", "reopened"], index);
    const priority = pick(["low", "medium", "high", "urgent"], index + 2);
    return {
      tenantId: tenant._id,
      ticketNumber: `TKT-DEMO-${config.slug.toUpperCase().slice(0, 4)}-${String(index + 1).padStart(4, "0")}`,
      title: pick([
        "Need invoice copy for event registration",
        "WhatsApp template approval is pending",
        "Lead source mapped to wrong website",
        "Unable to download visitor card attachment",
        "Request to merge duplicate buyer records",
        "SLA breach review for enterprise lead",
      ], index),
      description: "Seeded support ticket for dashboard, filters, SLA, assignment, remarks, and status badge testing.",
      status,
      priority,
      type: pick(["lead_inquiry", "support", "follow_up", "complaint", "feature_request", "general"], index),
      channel: pick(["web_form", "email", "phone", "whatsapp", "social_media", "manual"], index),
      assignedTo: owner._id,
      assignedAt: daysAgo(index % 20),
      assignedBy: admin._id,
      relatedEntity: { entityType: "lead", entityId: relatedLead._id },
      contactName: relatedLead.fullName,
      contactEmail: relatedLead.email,
      contactPhone: relatedLead.phone,
      companyName: relatedLead.company,
      dueDate: daysFromNow((index % 9) - 4),
      firstResponseAt: index % 4 === 0 ? null : daysAgo(index % 7),
      resolvedAt: ["resolved", "closed"].includes(status) ? daysAgo(index % 6) : null,
      closedAt: status === "closed" ? daysAgo(index % 4) : null,
      slaBreached: index % 8 === 0,
      nextFollowUpDate: ["resolved", "closed"].includes(status) ? null : daysFromNow((index % 7) - 2),
      contactAttempts: index % 5,
      tags: [pick(["billing", "integration", "duplicate", "sla", "attachment"], index)],
      websiteId: relatedLead.websiteId,
      source: relatedLead.source,
      statusHistory: [
        { fromStatus: null, toStatus: "open", changedBy: admin._id, changedAt: daysAgo(index % 22), note: "Ticket created." },
        { fromStatus: "open", toStatus: status, changedBy: owner._id, changedAt: daysAgo(index % 6), note: "Demo status transition." },
      ],
      createdBy: index % 5 === 0 ? admin._id : owner._id,
      createdAt: daysAgo(index % 40),
      updatedAt: daysAgo(index % 6),
    };
  }));

  await TicketRemark.insertMany(tickets.flatMap((ticket, index) => [
    {
      tenantId: tenant._id,
      ticket: ticket._id,
      user: ticket.assignedTo || admin._id,
      content: pick(["Customer asked for a callback after finance approval.", "Internal note: verify tenant isolation before sharing logs.", "Resolution sent with screenshots and next steps."], index),
      type: pick(["note", "call", "resolution", "escalation"], index),
      callDuration: index % 4 === 0 ? 420 : null,
      callOutcome: index % 4 === 0 ? "connected" : null,
      scheduledFollowUp: ticket.nextFollowUpDate,
      isInternal: index % 3 === 0,
      isPinned: ticket.priority === "urgent",
      createdAt: daysAgo(index % 12),
      updatedAt: daysAgo(index % 4),
    },
  ]));

  await Blog.insertMany([
    "How to run post-event follow-up without losing buyer context",
    "A practical CRM scorecard for founder-led sales teams",
    "Why approval-first AI messaging matters for customer trust",
    "WhatsApp templates that feel human and still stay compliant",
    "Quarterly pipeline cleanup checklist for revenue teams",
    "Draft: internal launch note for the new inbox workflow",
  ].map((title, index) => ({
    tenantId: tenant._id,
    websiteId: pick(websites, index)._id,
    title,
    slug: `${slugify(title)}-${config.slug}`,
    description: pick([
      "A practical operating guide for teams scaling customer conversations.",
      "A field-tested checklist with metrics, owners, and review cadence.",
      "A plain-language walkthrough for safer AI-assisted outbound work.",
    ], index),
    content: `# ${title}\n\nTeams that grow quickly need shared context, clean handoffs, and measurable follow-up quality. This demo article includes realistic metadata, categories, tags, and publication states for blog list/detail UI validation.\n\n## Operating notes\n\nUse CRM stages, inbox ownership, and approval queues together instead of treating them as separate tools.`,
    category: pick(["CRM", "Automation", "Events", "Inbox"], index),
    tags: [pick(["crm", "growth", "automation", "events"], index), "demo"],
    featuredImage: `https://images.unsplash.com/photo-1552664730-d307ca884978?auto=format&fit=crop&w=1400&q=80&sig=${index}`,
    featuredImageAlt: "Team reviewing revenue operations dashboard",
    author: admin._id,
    status: index === 5 ? "draft" : "published",
    publishedAt: index === 5 ? null : daysAgo(index * 7 + 1),
    views: index === 5 ? 0 : 340 + index * 287,
    seoTitle: title.slice(0, 60),
    seoDescription: "Demo SEO description for a realistic public blog integration.",
    seoKeywords: ["crm", "automation", "orbinest"],
    readingTime: 4 + (index % 3),
    isPublished: index !== 5,
    createdBy: admin._id,
    updatedBy: admin._id,
    createdAt: daysAgo(index * 8 + 4),
    updatedAt: daysAgo(index),
  })));

  const channelAccounts = await ChannelAccount.create([
    {
      tenantId: tenant._id,
      provider: "gmail",
      providerAccountId: `sales@${config.domainRoot}.co`,
      displayName: "Sales Gmail Inbox",
      status: "connected",
      scopes: ["gmail.readonly", "gmail.send"],
      syncCursor: "demo-history-41002",
      lastSyncAt: daysAgo(0, 12),
      connectedBy: admin._id,
      providerMeta: { email: `sales@${config.domainRoot}.co`, watchStatus: "active" },
    },
    {
      tenantId: tenant._id,
      provider: "whatsapp",
      providerAccountId: `wa-${config.slug}-phone-id`,
      displayName: "Main WhatsApp Business",
      status: "connected",
      scopes: ["whatsapp_business_messaging"],
      lastSyncAt: daysAgo(0, 12),
      connectedBy: admin._id,
      providerMeta: { phoneNumber: "+918880001234", businessAccountId: `waba-${config.slug}` },
    },
    {
      tenantId: tenant._id,
      provider: "gmail",
      providerAccountId: `ops@${config.domainRoot}.co`,
      displayName: "Ops Gmail Inbox",
      status: "error",
      consecutiveErrors: 3,
      lastError: "Demo OAuth token refresh failure for error-state QA.",
      connectedBy: admin._id,
    },
  ]);

  await WhatsappTemplate.insertMany([
    {
      tenantId: tenant._id,
      channelAccountId: channelAccounts[1]._id,
      name: "demo_followup",
      language: "en",
      category: "UTILITY",
      status: "approved",
      components: [{ type: "BODY", text: "Hi {{1}}, thanks for joining {{2}}. Would you like the pricing worksheet?" }],
      metaTemplateId: `tpl-${config.slug}-001`,
      createdBy: admin._id,
      syncedAt: daysAgo(1),
    },
    {
      tenantId: tenant._id,
      channelAccountId: channelAccounts[1]._id,
      name: "pricing_nudge",
      language: "en",
      category: "MARKETING",
      status: "pending",
      components: [{ type: "BODY", text: "Hi {{1}}, sharing the plan comparison you requested." }],
      createdBy: admin._id,
      syncedAt: daysAgo(2),
    },
  ]);

  const identities = await ContactIdentity.insertMany(contacts.slice(0, 18).flatMap((contact, index) => [
    {
      tenantId: tenant._id,
      contactId: contact._id,
      provider: "email",
      providerIdentifier: contact.email,
      displayName: contact.fullName,
      verified: true,
      lastSeenAt: daysAgo(index % 9),
    },
    {
      tenantId: tenant._id,
      contactId: contact._id,
      provider: "whatsapp",
      providerIdentifier: contact.phone,
      displayName: contact.fullName,
      verified: index % 4 !== 0,
      lastSeenAt: daysAgo(index % 7),
    },
  ]));

  const conversations = await Conversation.create(Array.from({ length: config.isActive ? 24 : 4 }, (_, index) => {
    const identity = pick(identities, index);
    const contact = contacts.find((item) => String(item._id) === String(identity.contactId)) || contacts[0];
    const channelAccount = identity.provider === "email" ? channelAccounts[0] : channelAccounts[1];
    return {
      tenantId: tenant._id,
      channelAccountId: channelAccount._id,
      channel: channelAccount.provider,
      providerThreadId: `demo-thread-${config.slug}-${index}`,
      contactId: contact._id,
      contactIdentityId: identity._id,
      participantName: contact.fullName,
      participantAvatar: index % 5 === 0 ? null : `https://api.dicebear.com/9.x/initials/svg?seed=${encodeURIComponent(contact.fullName)}`,
      status: pick(["open", "open", "snoozed", "closed"], index),
      assigneeId: pick(marketers, index)._id,
      priority: 1 + (index % 5),
      tags: [pick(["pricing", "event", "support", "vip"], index)],
      messageCount: 3 + (index % 5),
      unreadCount: index % 6 === 0 ? 3 : index % 3,
      lastMessageAt: daysAgo(index % 10, 9 + (index % 8)),
      lastMessageSnippet: pick(["Can you send the implementation plan?", "Thanks, this solves the invoice issue.", "Please confirm if WhatsApp reminders are included.", "Looping in our operations manager."], index),
      lastMessageDirection: pick(["inbound", "outbound"], index),
      firstMessageAt: daysAgo(12 + (index % 20)),
      firstUnrepliedAt: index % 5 === 0 ? daysAgo(index % 8) : null,
      firstReplyAt: index % 5 === 0 ? null : daysAgo(index % 7),
      dealId: deals[index % deals.length]._id,
      leadId: leads[index % leads.length]._id,
      createdAt: daysAgo(15 + (index % 20)),
      updatedAt: daysAgo(index % 5),
    };
  }));

  const messages = [];
  const approvals = [];
  conversations.forEach((conversation, index) => {
    const channelAccount = channelAccounts.find((item) => String(item._id) === String(conversation.channelAccountId));
    const owner = pick(marketers, index);
    const inboundAt = daysAgo((index % 8) + 2, 10);
    messages.push(
      {
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: channelAccount._id,
        channel: channelAccount.provider,
        direction: "inbound",
        status: "sent",
        providerMessageId: `msg-in-${config.slug}-${index}`,
        contentType: channelAccount.provider === "gmail" ? "html" : "text",
        subject: channelAccount.provider === "gmail" ? pick(["Demo pricing request", "Invoice copy needed", "Follow-up after roundtable"], index) : null,
        body: conversation.lastMessageSnippet,
        senderName: conversation.participantName,
        senderIdentifier: conversation.channel === "gmail" ? contacts[index % contacts.length].email : contacts[index % contacts.length].phone,
        contactIdentityId: conversation.contactIdentityId,
        providerTimestamp: inboundAt,
        createdAt: inboundAt,
        updatedAt: inboundAt,
      },
      {
        tenantId: tenant._id,
        conversationId: conversation._id,
        channelAccountId: channelAccount._id,
        channel: channelAccount.provider,
        direction: "outbound",
        status: index % 7 === 0 ? "failed" : pick(["sent", "delivered", "read", "pending"], index),
        providerMessageId: `msg-out-${config.slug}-${index}`,
        contentType: "text",
        subject: channelAccount.provider === "gmail" ? `Re: ${pick(["Demo pricing request", "Invoice copy needed", "Follow-up after roundtable"], index)}` : null,
        body: pick(["Sharing the implementation plan and commercial worksheet now.", "Confirmed. I have attached the invoice and QR confirmation.", "I can reserve a slot tomorrow at 11:30 AM."], index),
        senderName: owner.name,
        senderIdentifier: channelAccount.providerAccountId,
        sentByUserId: owner._id,
        aiGenerated: index % 4 === 0,
        providerTimestamp: daysAgo(index % 5, 13),
        failedAt: index % 7 === 0 ? daysAgo(index % 5, 13) : null,
        failureReason: index % 7 === 0 ? "Demo provider rejected message for visual failed state." : null,
        createdAt: daysAgo(index % 5, 13),
        updatedAt: daysAgo(index % 5, 13),
      },
    );
  });
  const insertedMessages = await Message.insertMany(messages);
  insertedMessages
    .filter((message) => message.direction === "outbound" && message.aiGenerated)
    .slice(0, 8)
    .forEach((message, index) => {
      approvals.push({
        tenantId: tenant._id,
        type: message.channel === "gmail" ? "gmail.send" : "whatsapp.send",
        status: pick(["pending", "approved", "rejected", "auto_approved"], index),
        relatedEntityType: "message",
        relatedEntityId: message._id,
        summary: message.body,
        metadata: { channel: message.channel, demo: true },
        aiGenerated: true,
        confidence: Number((0.62 + (index % 4) * 0.08).toFixed(2)),
        requestedBy: pick(marketers, index)._id,
        decidedBy: index % 4 === 0 ? null : admin._id,
        decidedAt: index % 4 === 0 ? null : daysAgo(index % 3),
        decisionReason: index % 4 === 2 ? "Tone was too promotional for the customer context." : null,
        expiresAt: daysFromNow(7 - index),
        createdAt: daysAgo(index % 6),
        updatedAt: daysAgo(index % 3),
      });
    });
  const insertedApprovals = await ApprovalRequest.insertMany(approvals);
  for (const approval of insertedApprovals) {
    await Message.updateOne({ _id: approval.relatedEntityId }, { approvalRequestId: approval._id });
  }

  await CrmActivity.insertMany([
    ...deals.slice(0, 18).map((deal, index) => ({
      tenantId: tenant._id,
      type: pick(["task", "call", "meeting", "email"], index),
      subject: pick(["Send commercial proposal", "Discovery call", "Procurement review meeting", "Follow-up with champion"], index),
      description: "Demo CRM activity linked to deal/contact/account detail views.",
      status: pick(["planned", "in_progress", "completed", "cancelled"], index),
      priority: pick(["low", "medium", "high"], index),
      dueDate: daysFromNow((index % 10) - 3),
      completedAt: index % 4 === 2 ? daysAgo(index % 5) : null,
      ownerId: deal.ownerId,
      relatedTo: { entityType: "deal", entityId: deal._id },
      location: index % 4 === 2 ? "Google Meet" : "",
      callDuration: index % 4 === 1 ? 28 : 0,
      callResult: index % 4 === 1 ? "connected" : null,
      tags: [pick(["proposal", "procurement", "technical", "nurture"], index)],
      createdAt: daysAgo(index % 30),
      updatedAt: daysAgo(index % 4),
    })),
    ...leads.slice(0, 12).map((lead, index) => ({
      tenantId: tenant._id,
      type: "task",
      subject: `Qualify ${lead.company || lead.fullName}`,
      status: pick(["planned", "completed", "in_progress"], index),
      priority: pick(["medium", "high", "low"], index),
      dueDate: daysFromNow((index % 8) - 2),
      ownerId: lead.assignedTo || rohan._id,
      relatedTo: { entityType: "lead", entityId: lead._id },
      tags: ["lead-followup"],
      createdAt: daysAgo(index % 12),
      updatedAt: daysAgo(index % 3),
    })),
  ]);

  await AutomationRule.insertMany([
    {
      tenantId: tenant._id,
      name: "Assign high intent website leads",
      description: "Routes high-scoring public-form leads to the least-loaded marketer.",
      isActive: true,
      module: "lead",
      trigger: { type: "on_create", config: { source: "website" } },
      conditions: [{ field: "score", operator: "greater_than", value: 70 }],
      actions: [{ type: "assign_owner", config: { strategy: "least_loaded" } }, { type: "create_task", config: { dueInHours: 4 } }],
      executionCount: 31,
      lastExecutedAt: daysAgo(0, 12),
      createdBy: admin._id,
    },
    {
      tenantId: tenant._id,
      name: "Escalate stale urgent tickets",
      description: "Creates an internal notification for urgent tickets without first response.",
      isActive: true,
      module: "activity",
      trigger: { type: "time_based", config: { cronExpression: "0 */2 * * *" } },
      conditions: [{ field: "priority", operator: "equals", value: "urgent" }],
      actions: [{ type: "send_notification", config: { channel: "in_app" } }],
      executionCount: 8,
      lastExecutedAt: daysAgo(1, 8),
      createdBy: admin._id,
    },
  ]);

  const workflow = await Workflow.create({
    tenantId: tenant._id,
    name: "AI-assisted Gmail reply approval",
    description: "Drafts a reply for inbound Gmail conversations and requires human approval before sending.",
    status: "active",
    isActive: true,
    nodes: [
      { id: "trigger_1", type: "trigger", subtype: "trigger.gmail.message_received", label: "Gmail message received", position: { x: 80, y: 120 } },
      { id: "ai_1", type: "ai", subtype: "ai.draft.email", label: "Draft reply", position: { x: 360, y: 120 }, config: { tone: "helpful", maxWords: 120 } },
      { id: "approval_1", type: "approval", subtype: "approval.request", label: "Human approval", position: { x: 640, y: 120 } },
      { id: "send_1", type: "action", subtype: "action.gmail.send", label: "Send Gmail reply", position: { x: 920, y: 120 }, requiresApproval: true },
    ],
    edges: [
      { id: "edge_1", from: "trigger_1", to: "ai_1" },
      { id: "edge_2", from: "ai_1", to: "approval_1" },
      { id: "edge_3", from: "approval_1", to: "send_1", label: "approved" },
    ],
    singleton: true,
    maxConcurrency: 5,
    stats: { runCount: 42, successCount: 35, failureCount: 7, lastRunAt: daysAgo(0, 12) },
    createdBy: admin._id,
    updatedBy: admin._id,
  });

  await WorkflowRun.insertMany(["succeeded", "failed", "waiting", "running"].map((status, index) => ({
    tenantId: tenant._id,
    workflowId: workflow._id,
    workflowLineageId: workflow.lineageId,
    workflowVersion: 1,
    triggerSource: {
      type: "webhook",
      subtype: "trigger.gmail.message_received",
      entityType: "message",
      entityId: insertedMessages[index]?._id || null,
      payload: { demo: true },
    },
    status,
    currentNodeId: status === "running" ? "ai_1" : status === "waiting" ? "approval_1" : null,
    startedAt: daysAgo(index + 1),
    finishedAt: ["succeeded", "failed"].includes(status) ? daysAgo(index) : null,
    nodeRuns: [
      {
        nodeId: "trigger_1",
        nodeType: "trigger",
        nodeSubtype: "trigger.gmail.message_received",
        status: "succeeded",
        startedAt: daysAgo(index + 1),
        finishedAt: daysAgo(index + 1),
        attemptsMade: 1,
      },
      {
        nodeId: "ai_1",
        nodeType: "ai",
        nodeSubtype: "ai.draft.email",
        status: status === "failed" ? "failed" : status === "running" ? "running" : "succeeded",
        startedAt: daysAgo(index + 1),
        finishedAt: status === "running" ? null : daysAgo(index + 1),
        attemptsMade: status === "failed" ? 3 : 1,
        error: status === "failed" ? { message: "Provider timeout while generating draft.", nonRetryable: false } : undefined,
      },
    ],
    error: status === "failed" ? "Provider timeout while generating draft." : null,
    createdAt: daysAgo(index + 1),
    updatedAt: daysAgo(index),
  })));

  await IntegrationEvent.insertMany(Array.from({ length: 18 }, (_, index) => ({
    tenantId: tenant._id,
    provider: pick(["gmail", "whatsapp", "meta", "gmb"], index),
    eventType: pick(["gmail.history", "whatsapp.message", "meta.comment", "gmb.review"], index),
    externalEventId: `demo-${config.slug}-${index}`,
    channelAccountId: pick(channelAccounts, index)._id,
    payload: { demo: true, sequence: index },
    signatureVerified: index % 5 !== 0,
    enqueuedJobId: index % 4 === 0 ? null : `job-${config.slug}-${index}`,
    enqueuedAt: index % 4 === 0 ? null : daysAgo(index % 8),
    processedAt: index % 6 === 0 ? null : daysAgo(index % 7),
    status: pick(["received", "enqueued", "processed", "failed", "skipped"], index),
    statusReason: index % 5 === 0 ? "Demo invalid signature or unknown channel account." : null,
    createdAt: daysAgo(index % 20),
    updatedAt: daysAgo(index % 7),
  })));

  await FailedJob.insertMany([
    {
      tenantId: String(tenant._id),
      queueName: "gmail.send",
      jobName: "sendApprovedMessage",
      jobId: `demo-gmail-fail-${config.slug}`,
      attemptsMade: 5,
      maxAttempts: 5,
      failedReason: "Gmail API returned 429 rate limit during demo seed.",
      nonRetryable: false,
      payload: { tenantId: String(tenant._id), messageId: insertedMessages[1]?._id },
      failedAt: daysAgo(2, 15),
      status: "failed",
    },
    {
      tenantId: String(tenant._id),
      queueName: "workflow.execute",
      jobName: "runWorkflow",
      jobId: `demo-workflow-discarded-${config.slug}`,
      attemptsMade: 1,
      maxAttempts: 1,
      failedReason: "Demo non-retryable validation error.",
      nonRetryable: true,
      payload: { workflowId: workflow._id },
      failedAt: daysAgo(6, 11),
      status: "discarded",
      resolvedAt: daysAgo(5),
      resolvedBy: String(admin._id),
    },
  ]);

  await UsageMetric.insertMany(Array.from({ length: 75 }, (_, index) => {
    const date = daysAgo(74 - index).toISOString().slice(0, 10);
    const weekday = new Date(date).getDay();
    const seasonBoost = index > 55 ? 1.45 : index > 30 ? 1.15 : 0.9;
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.65 : 1;
    return {
      tenantId: tenant._id,
      date,
      leadsCreated: Math.round((4 + (index % 9)) * seasonBoost * weekendFactor),
      activeUsers: Math.max(1, Math.round((2 + (index % marketers.length)) * weekendFactor + (config.plan === "agency" ? 2 : 0))),
      apiCalls: Math.round((120 + index * 9 + (index % 7) * 31) * seasonBoost),
      storageBytes: 15_000_000 + index * 420_000,
      createdAt: daysAgo(74 - index),
      updatedAt: daysAgo(74 - index),
    };
  }));

  await ActivityLog.insertMany([
    ...clients.slice(0, 24).map((client, index) => ({
      tenantId: tenant._id,
      user: client.marketingPerson,
      action: pick(["client_create", "client_update", "client_status_change", "remark_create"], index),
      resourceType: "client",
      resourceId: client._id,
      description: `${pick(marketers, index).name} updated ${client.companyName}.`,
      metadata: { status: client.followUpStatus, priority: client.priority },
      ipAddress: `10.10.0.${index + 10}`,
      userAgent: pick(["Chrome", "Edge", "Safari"], index),
      createdAt: daysAgo(index % 14),
      updatedAt: daysAgo(index % 5),
    })),
    ...events.slice(0, 4).map((event, index) => ({
      tenantId: tenant._id,
      user: admin._id,
      action: pick(["event_create", "event_update"], index),
      resourceType: "event",
      resourceId: event._id,
      description: `Event workspace updated: ${event.name}.`,
      metadata: { status: event.status, budget: event.budget },
      createdAt: daysAgo(index + 1),
      updatedAt: daysAgo(index),
    })),
  ]);

  await AuditLog.insertMany([
    ...users.slice(0, 4).map((user, index) => ({
      tenantId: tenant._id,
      userId: admin._id,
      action: pick(["user.create", "user.update", "settings.update", "workflow.update"], index),
      entityType: pick(["user", "user", "settings", "workflow"], index),
      entityId: index < 2 ? user._id : index === 2 ? tenant._id : workflow._id,
      description: `Demo audit event for ${user.email}.`,
      metadata: { demo: true, role: user.role },
      requestId: `req-demo-${config.slug}-${index}`,
      ipAddress: `172.16.1.${index + 20}`,
      userAgent: "SeedDemo/1.0",
      createdAt: daysAgo(index + 1),
      updatedAt: daysAgo(index + 1),
    })),
    {
      tenantId: tenant._id,
      userId: platformUser._id,
      action: config.isActive ? "tenant.update" : "tenant.suspend",
      entityType: "tenant",
      entityId: tenant._id,
      description: `Platform owner ${config.isActive ? "reviewed" : "suspended"} tenant ${tenant.slug}.`,
      metadata: { plan: tenant.plan, active: tenant.isActive },
      requestId: `req-platform-${config.slug}`,
      ipAddress: "172.16.0.10",
      userAgent: "SeedDemo/1.0",
      createdAt: daysAgo(config.isActive ? 2 : 21),
      updatedAt: daysAgo(config.isActive ? 2 : 21),
    },
  ]);

  await UserSession.insertMany(users.slice(0, 4).map((user, index) => ({
    tenantId: tenant._id,
    user: user._id,
    refreshTokenHash: crypto.createHash("sha256").update(`${config.slug}-${user.email}`).digest("hex"),
    userAgent: pick(["Chrome on Windows", "Safari on iPhone", "Edge on Windows"], index),
    ipAddress: `49.207.10.${index + 40}`,
    isActive: index < 2 && config.isActive,
    loginTime: daysAgo(index, 9 + index),
    lastActivityAt: daysAgo(index, 10 + index),
    logoutTime: index < 2 && config.isActive ? null : daysAgo(index, 18),
    createdAt: daysAgo(index, 9),
    updatedAt: daysAgo(index, 10),
  })));

  await Tenant.updateOne(
    { _id: tenant._id },
    {
      activeUsers: users.filter((user) => user.isActive).length,
      lastActivityAt: config.isActive ? daysAgo(0, 12) : daysAgo(16),
    },
  );

  return {
    tenant,
    users,
    websites,
    events,
    leads,
    clients,
    accounts,
    contacts,
    deals,
    tickets,
    registrations: insertedRegistrations,
    conversations,
  };
};

const run = async () => {
  await connect();
  await resetDemoData();

  if (resetOnly) {
    console.log("Demo data reset complete.");
    return;
  }

  const { platformTenant, superadmin } = await seedPlatform();
  const seededTenants = [];
  for (const config of tenantConfigs) {
    seededTenants.push(await seedTenant(config, superadmin));
  }

  await UsageMetric.insertMany(Array.from({ length: 45 }, (_, index) => ({
    tenantId: platformTenant._id,
    date: daysAgo(44 - index).toISOString().slice(0, 10),
    leadsCreated: seededTenants.reduce((sum, item) => sum + Math.round((item.leads.length / 60) * (1 + (index % 5))), 0),
    activeUsers: 5 + (index % 8),
    apiCalls: 900 + index * 37,
    storageBytes: 90_000_000 + index * 1_800_000,
    createdAt: daysAgo(44 - index),
    updatedAt: daysAgo(44 - index),
  })));

  console.log("\nOrbinest production-style demo data seeded.");
  console.log("Credentials:");
  console.log(`  Super Admin: owner@${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
  for (const { tenant } of seededTenants) {
    console.log(`  ${tenant.name}: admin@${tenant.slug}.${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
    console.log(`  ${tenant.name}: rohan@${tenant.slug}.${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
    console.log(`  ${tenant.name}: meera@${tenant.slug}.${DEMO_EMAIL_DOMAIN} / ${DEMO_PASSWORD}`);
  }
  console.log("\nDemo tenant slugs:", DEMO_TENANT_SLUGS.join(", "));
};

run()
  .catch((error) => {
    console.error("Demo seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
