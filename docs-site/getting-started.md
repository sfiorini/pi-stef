# Getting Started

## Prerequisites

Before installing, make sure you have:

- **[pi](https://pi.dev)** (>= 0.70) — the coding agent these packages extend
- **[Node.js](https://nodejs.org/)** (>= 20) — JavaScript runtime
- **[pnpm](https://pnpm.io/)** (>= 9) — package manager (used for development)
- **[GitHub CLI](https://cli.github.com/)** (`gh`) — required for catalog login and sync

## Option 1: Use the Catalog (Recommended)

The catalog is a declarative package manager that keeps your packages in sync across machines via GitHub Gist.

### Step 1: Install the catalog

```bash
pi install npm:@pi-stef/catalog
```

### Step 2: Authenticate with GitHub

```bash
/ct login
```

This requires the GitHub CLI (`gh`) to be installed and authenticated. If you haven't done so:

```bash
# Install gh (macOS)
brew install gh

# Authenticate
gh auth login
```

### Step 3: Initialize your catalog

```bash
/ct init
```

This creates a `cat.yaml` file that declares your packages.

### Step 4: Add packages

```bash
/ct add npm:@pi-stef/flow
/ct add npm:@pi-stef/web
/ct add npm:@pi-stef/figma
```

### Step 5: Sync

```bash
/ct sync
```

This installs all enabled packages and pushes your catalog to a GitHub Gist for cross-machine sync.

## Option 2: Install Individual Packages

If you don't want catalog management, install packages directly:

```bash
pi install npm:@pi-stef/azure-foundry
pi install npm:@pi-stef/cursor
pi install npm:@pi-stef/flow
pi install npm:@pi-stef/web
pi install npm:@pi-stef/figma
pi install npm:@pi-stef/atlassian
```

Each package works independently. Check each package's documentation for its specific setup requirements.

## Option 3: Import a Shared Catalog

If someone shared a catalog gist with you:

```bash
pi install npm:@pi-stef/catalog
/ct login
/ct init --from-gist=<gist-id>
/ct sync
```

This imports their entire catalog (including profiles) and installs all packages.

## What's Next?

- [Catalog Guide](/catalog-guide) — deep dive into catalog management
- [Profiles & Sharing](/profiles) — manage different package sets for different machines
- [Packages](/packages/) — explore all available packages
