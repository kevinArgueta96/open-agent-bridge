import { createRouter, createWebHashHistory } from "vue-router";
import type { RouteRecordRaw } from "vue-router";

const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "cockpit",
    component: () => import("@/views/CockpitView.vue"),
  },
  {
    path: "/network",
    name: "network",
    component: () => import("@/views/NetworkView.vue"),
  },
  {
    path: "/agents/:id",
    name: "agent-detail",
    component: () => import("@/views/AgentDetailView.vue"),
    props: true,
  },
  // Parked (operational) surfaces — reachable by deep link, not in the primary nav.
  {
    path: "/inbox",
    name: "inbox",
    component: () => import("@/views/InboxView.vue"),
  },
  {
    path: "/plans",
    name: "plans",
    component: () => import("@/views/PlansView.vue"),
  },
  // Legacy redirect
  {
    path: "/channels",
    redirect: "/inbox",
  },
  {
    path: "/:pathMatch(.*)*",
    redirect: "/",
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
