# WasteHero Platform Reference

> Auto-generated from `WasteHero/wastehero_frontend` source code.
> Last updated: 2026-04-09

---

## Architecture Overview

| Aspect | Technology |
|--------|-----------|
| Framework | React 18.2 + Vite 5 |
| Language | TypeScript 5.2 |
| Routing | React Router v5 (custom RouterFactory) |
| UI Library | Ant Design 5.15 |
| State | Zustand 4.5 + React Context |
| API | GraphQL (Apollo Client 3.7) |
| Styling | Styled-components 5.3 + Ant Design theming |
| Maps | Mapbox GL 2.9 |
| i18n | Transifex |
| Charts | Plotly.js + Ant Design Charts |
| Error Tracking | Sentry |
| Analytics | Mixpanel |
| Payments | Stripe |
| Build | Vite (manual chunks: mapbox, apollo, charts) |
| Package Manager | Yarn 1.22 |
| Node | 22.x |

### Source Structure

```
src/
  App/                    # Entry point, route config
  api/                    # API constants, filters
  antd/                   # Ant Design overrides
  components/             # ~936 components (legacy structure)
    graphql/              # Apollo client setup
    layout/               # Header, sidebar, nav
    main/                 # Main feature routes
    shared/               # Reusable UI
  new-components/         # ~728 components (modern structure)
    antdform-kit/         # Form builders
    modals/               # Modals
    tables/               # Table variants
    select/               # Select components
  pages/                  # ~22 page components
  contexts/               # React Context factories
  hooks/                  # Custom hooks
  ui/                     # ~57 base UI components
  mapbox/                 # Mapbox integration
  styles/                 # Global theme
  reducers/               # Routing state
  consts/                 # Constants & enums
  icons/                  # Icon assets
  utils/                  # Utilities
```

---

## Sidebar Navigation

Defined in `src/components/layout/sidebar/components/NavigationMenu/getItems.tsx`.

### 1. Data & Analytics (`DashboardOutlined`)

| Item | Icon | Route |
|------|------|-------|
| Overview | `UnorderedListOutlined` | `/app/dashboard` |
| Dashboards | `BarChartOutlined` | `/app/analytics/dashboards` |
| Data Exports | `CloudDownloadOutlined` | `/app/analytics/exports` |
| Classic Exports | `FileTextOutlined` | `/app/analytics/classic-exports` |
| Data Imports | `CloudUploadOutlined` | `/app/analytics/imports` |

### 2. Customers (`TeamOutlined`)

| Item | Icon | Route |
|------|------|-------|
| Properties | `HomeOutlined` | `/app/customer-management/properties` |
| Map View | `EnvironmentOutlined` | `/app/customer-management/properties/map` |
| Groups | `ApartmentOutlined` | `/app/customer-management/property-groups` |
| Contacts | `UserOutlined` | `/app/customer-management/contacts` |
| SMS/Email Service | `MessageOutlined` | `/app/customer-management/subscriptions` |

### 3. Tickets (`CustomerServiceOutlined`)

| Item | Icon | Route |
|------|------|-------|
| Overview | `FileDoneOutlined` | `/app/tickets` |
| Map View | `EnvironmentOutlined` | `/app/tickets/map` |
| Kanban | `AlignLeftOutlined` | `/app/tickets/kanban` |
| Customer Inbox | `MailOutlined` | `/app/tickets/customer-inbox` |

### 4. Operations (`SettingOutlined`)

| Item | Icon | Route | Notes |
|------|------|-------|-------|
| Live Monitoring | `MonitorOutlined` | `/app/operation-management/live-monitoring` | **Requires `live-monitoring` role** |
| Routes | `NodeIndexOutlined` | `/app/operation-management/routes` | |
| Route Schemes | `SlidersOutlined` | `/app/operation-management/route-schemes` | |
| Pickup History | `HistoryOutlined` | `/app/operation-management/pickup-history` | |
| Weight Control | `ToolOutlined` | `/app/operation-management/weight-control` | |

### 5. Fleet (`TruckOutlined`)

| Item | Icon | Route |
|------|------|-------|
| Vehicles | `CarOutlined` | `/app/fleet-management/vehicles` |
| Drivers | `TeamOutlined` | `/app/fleet-management/drivers` |
| Locations | `BankOutlined` | `/app/fleet-management/locations` |
| Planning | `SettingOutlined` | `/app/fleet-management/vehicle-planner` |

### 6. Assets (`ContainerOutlined`)

| Item | Icon | Route |
|------|------|-------|
| Containers | `RestOutlined` | `/app/asset-management/containers` |
| Map View | `EnvironmentOutlined` | (asset map) |
| Groups | `ApartmentOutlined` | `/app/asset-management/container-group` |

### 7. Alerts (`NotificationOutlined`)

| Item | Route |
|------|-------|
| Alerts | `/app/notifications/alerts` |

---

## Complete Route Map

### Authentication (unauthenticated)

| Route | Description |
|-------|-------------|
| `/login` | Login page |
| `/register` | Registration |
| `/forgot-password` | Password recovery |
| `/reset` | Change password |
| `/user-register/:email/:id` | Registration with token |
| `/user-invite/:email/:id` | Invitation acceptance |
| `/privacy-policy` | Privacy policy (all users) |

### Dashboard & Analytics

| Route | Description |
|-------|-------------|
| `/app/dashboard` | Main dashboard (KPIs, charts) |
| `/app/analytics/dashboards` | Custom dashboards list |
| `/app/analytics/dashboards/:id` | View dashboard |
| `/app/analytics/exports` | Data export templates |
| `/app/analytics/exports/:id` | Export template detail |
| `/app/analytics/classic-exports` | Completed exports (downloadable .xlsx/.csv) |
| `/app/analytics/imports` | Data imports |

### Customer Management

| Route | Description |
|-------|-------------|
| `/app/customer-management/properties` | All properties list |
| `/app/customer-management/properties/map` | Properties map view |
| `/app/customer-management/properties/create` | Create new property |
| `/app/customer-management/properties/:id` | Property detail |
| `/app/customer-management/properties/:id/edit` | Edit property |
| `/app/customer-management/properties/search` | Property search |
| `/app/customer-management/contacts` | All contacts |
| `/app/customer-management/contacts/create` | Create contact |
| `/app/customer-management/contacts/:id` | Contact detail |
| `/app/customer-management/property-groups` | Property groups |
| `/app/customer-management/property-groups/:id` | Group detail |
| `/app/customer-management/subscriptions` | SMS/Email service |
| `/app/customer-management/agreements` | Agreements |
| `/app/customer-management/inquiry-management` | Inquiries |

### Tickets

| Route | Description |
|-------|-------------|
| `/app/tickets` | All tickets list |
| `/app/tickets/:id` | Ticket detail |
| `/app/tickets/kanban` | Kanban board |
| `/app/tickets/map` | Tickets map |
| `/app/tickets/customer-inbox` | Customer inbox |
| `/app/tickets/drafts` | Draft tickets |
| `/app/tickets/drafts/:id` | Draft detail |
| `/app/tickets/create-bulk` | Create bulk tickets |
| `/app/tickets/edit-bulk` | Edit bulk tickets |

### Operations

| Route | Description |
|-------|-------------|
| `/app/operation-management/live-monitoring` | Live monitoring (role-gated) |
| `/app/operation-management/routes` | All routes |
| `/app/operation-management/routes/create` | Create route |
| `/app/operation-management/routes/:id` | Route detail |
| `/app/operation-management/route-schemes` | Route scheme templates |
| `/app/operation-management/route-schemes/create` | Create scheme |
| `/app/operation-management/route-schemes/:id` | Scheme detail |
| `/app/operation-management/pickup-history` | Pickup history |
| `/app/operation-management/pickup-history/:id` | Pickup detail |
| `/app/operation-management/weight-control` | Weight control (Need Approval / Awaiting / Completed) |
| `/app/operation-management/approval-collection` | Approval collection |
| `/app/operation-management/route-problem-errors` | Route errors |

### Fleet Management

| Route | Description |
|-------|-------------|
| `/app/fleet-management/vehicles` | All vehicles |
| `/app/fleet-management/vehicles/create` | Create vehicle |
| `/app/fleet-management/vehicles/:vehicleId` | Vehicle detail |
| `/app/fleet-management/drivers` | All drivers |
| `/app/fleet-management/drivers/create` | Create driver |
| `/app/fleet-management/drivers/:driverId` | Driver detail |
| `/app/fleet-management/locations` | All locations |
| `/app/fleet-management/locations/create` | Create location |
| `/app/fleet-management/locations/:locationId` | Location detail |
| `/app/fleet-management/vehicle-planner` | Vehicle planner |

### Asset Management

| Route | Description |
|-------|-------------|
| `/app/asset-management/containers` | All containers |
| `/app/asset-management/containers/create` | Create container |
| `/app/asset-management/containers/:id` | Container detail |
| `/app/asset-management/container-group` | Container groups |
| `/app/asset-management/container-group/:id` | Group detail |

### Alerts

| Route | Description |
|-------|-------------|
| `/app/notifications/alerts` | All alerts |
| `/app/notifications/alerts/:id` | Alert events |

### Settings

| Route | Description |
|-------|-------------|
| `/app/settings/company/:id/general` | Company general info |
| `/app/settings/company/:id/settings` | Company configuration |
| `/app/settings/company/:id/user-management` | User administration |
| `/app/settings/company/:id/custom-fields` | Custom fields |
| `/app/settings/company/:id/crm` | CRM settings |
| `/app/settings/company/:id/crm/pricing` | CRM pricing |
| `/app/settings/company/:id/crm/services` | CRM services |
| `/app/settings/company/:id/crm/scheduled-exports` | Scheduled exports |
| `/app/settings/company/:id/crm/billing-runs` | Billing runs |
| `/app/settings/company/:id/crm/data-sync` | Data sync config |
| `/app/settings/company/:id/crm/integrations` | CRM integrations |
| `/app/settings/company/:id/crm-portal` | Portal settings |
| `/app/settings/company/:id/fleet-management` | Fleet settings |
| `/app/settings/company/:id/operation-management` | Operations settings |
| `/app/settings/company/:id/operation-management/areas` | Areas |
| `/app/settings/company/:id/operation-management/haulers` | Haulers |
| `/app/settings/company/:id/operation-management/pickup-settings` | Pickup settings |
| `/app/settings/company/:id/tickets` | Ticket settings |
| `/app/settings/company/:id/asset-management` | Asset settings |
| `/app/settings/company/:id/email-accounts` | Email config |
| `/app/settings/company/:id/alert-rules` | Alert rules |
| `/app/settings/company/:id/communication` | Communication settings |
| `/app/settings/company/:id/documents` | Documents |
| `/app/settings/company/:id/billing` | Billing management |
| `/app/settings/company/:id/history` | Audit log |
| `/app/settings/projects` | Project management |
| `/app/settings/projects/create` | Create project |

### User Profile

| Route | Description |
|-------|-------------|
| `/app/profile` | Current user profile |
| `/app/profile/information` | User info |
| `/app/profile/api-keys` | API keys |
| `/app/profile/user-projects` | User projects |
| `/app/users/:userId` | View other user |

### Other

| Route | Description |
|-------|-------------|
| `/app/market-place` | Marketplace |
| `/app/reports` | Reports |
| `/app/support` | Support |
| `/company/create` | Create company (onboarding) |
| `/app/control-center/*` | WasteHero staff admin (internal only) |

---

## User Roles

| Role | Description | Access |
|------|-------------|--------|
| `authenticated` | Normal logged-in user | All standard routes |
| `non-authenticated` | Not logged in | Login, register, password reset |
| `wastehero-staff` | Internal WasteHero team | Control Center + all features |
| `live-monitoring` | Specific company capability | Operations > Live Monitoring |
| `impersonator` | Admin impersonating a user | Extended access |

---

## Key UI Patterns

- **List pages**: Ant Design Table with Search, Filter (funnel icon), Date range, Reset all, Action dropdown, Pagination (10 or 20/page), List/Map/Grid view toggles
- **Detail pages**: Navigated via `View` button or clicking row, URL pattern `/:id`
- **Create flows**: Via Action dropdown ("Add property", etc.) or dedicated `/create` routes
- **Bulk operations**: Select rows via checkboxes + Action dropdown for bulk actions
- **Kanban**: Drag-and-drop columns (Created / Open / Pending / etc.)
- **Export**: Data & Analytics > Data Exports for templates, Classic Exports for downloads
- **Filters**: Star (saved filters), Funnel (filter panel), Calendar (date range)
