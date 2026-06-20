import { defineConfig } from "vitepress";

export default defineConfig({
  title: "pi-stef",
  description:
    "Custom package collection for the pi coding agent",
  base: "/pi-stef/",

  themeConfig: {
    nav: [
      { text: "Home", link: "/" },
      { text: "Getting Started", link: "/getting-started" },
      { text: "Packages", link: "/packages/" },
      { text: "Catalog Guide", link: "/catalog-guide" },
      { text: "Development", link: "/development" },
    ],

    sidebar: [
      {
        text: "Guide",
        items: [
          { text: "Getting Started", link: "/getting-started" },
          { text: "Catalog Guide", link: "/catalog-guide" },
          { text: "Profiles & Sharing", link: "/profiles" },
          { text: "Migrating from superpowers-adapter", link: "/migrating-from-superpowers-adapter" },
        ],
      },
      {
        text: "Packages",
        items: [
          { text: "Overview", link: "/packages/" },
          { text: "azure-foundry", link: "/packages/azure-foundry" },
          { text: "catalog", link: "/packages/catalog" },
          { text: "cursor", link: "/packages/cursor" },
          { text: "pair", link: "/packages/pair" },
          { text: "team", link: "/packages/team" },
          { text: "atlassian", link: "/packages/atlassian" },
          { text: "figma", link: "/packages/figma" },
          { text: "web", link: "/packages/web" },
          { text: "paths", link: "/packages/paths" },
        ],
      },
      {
        text: "Development",
        items: [
          { text: "Contributing", link: "/development" },
        ],
      },
    ],

    socialLinks: [
      { icon: "github", link: "https://github.com/sfiorini/pi-stef" },
    ],

    search: {
      provider: "local",
    },

    editLink: {
      pattern:
        "https://github.com/sfiorini/pi-stef/edit/main/docs-site/:path",
    },
  },
});
