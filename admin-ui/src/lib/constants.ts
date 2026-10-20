export const APP_NAME = "Ekatra";
export const APP_DESCRIPTION = "Learning Platform";

export const ROUTES = {
  HOME: "/",
  LOGIN: "/",
  DASHBOARD: "/dashboard",
  COURSES: "/courses",
  LEARNERS: "/learners",
  DELIVERY: "/delivery",
  FAILURES: "/failures",
  CERTIFICATES: "/certificates",
  USERS: "/users",
  SCHEDULES: "/schedules",
  SETTINGS: "/settings",
};

export const DASHBOARD_SECTIONS = [
  { name: "Overview", path: ROUTES.DASHBOARD, icon: "LayoutDashboard" },
  { name: "Courses", path: ROUTES.COURSES, icon: "BookOpen" },
  { name: "Learners", path: ROUTES.LEARNERS, icon: "Users" },
  { name: "Delivery", path: ROUTES.DELIVERY, icon: "MessageCircle" },
  { name: "Failures", path: ROUTES.FAILURES, icon: "AlertTriangle" },
  { name: "Certificates", path: ROUTES.CERTIFICATES, icon: "Award" },
  { name: "Schedules", path: ROUTES.SCHEDULES, icon: "Clock" },
  { name: "Users", path: ROUTES.USERS, icon: "User" },
  { name: "Settings", path: ROUTES.SETTINGS, icon: "Settings" },
];
