# Profiles & Sharing

Profiles let you maintain different package sets for different machines or contexts (e.g., work vs. personal).

## Creating Profiles

```bash
/ct profile work --create    # Create a "work" profile
/ct profile personal --create  # Create a "personal" profile
```

## Switching Profiles

```bash
/ct profile work      # Switch to work profile
/ct profile personal  # Switch to personal profile
/ct profile default   # Switch back to default
```

## Listing Profiles

```bash
/ct profiles
```

Output shows all profiles with the active one marked with `*`.

## How Profiles Work

Profiles are stored in `cat.yaml` under the `profiles` section:

```yaml
meta:
  activeProfile: work

packages:
  team:
    source: npm:@pi-stef/flow
    enabled: true
  web:
    source: npm:@pi-stef/web
    enabled: true

profiles:
  work:
    packages:
      atlassian:
        source: npm:@pi-stef/atlassian
        enabled: true
      figma:
        source: npm:@pi-stef/figma
        enabled: true
  personal:
    packages:
      web:
        source: npm:@pi-stef/web
        enabled: false
```

A profile's packages are merged on top of the base `packages`. A profile can:

- **Add** packages not in the base set
- **Override** properties (like `source` or `enabled`) of base packages
- **Disable** a base package by setting `enabled: false`

## Syncing Profiles

Each profile syncs to its own GitHub Gist (identified by description `catalog-<profile-name>`):

```bash
/ct sync --profile work      # Sync work profile to its gist
/ct sync --profile personal  # Sync personal profile to its gist
```

## Sharing Catalogs

### Share your catalog

Your catalog is stored as a GitHub Gist. To share it:

1. Find your gist at `https://gist.github.com/<your-username>`
2. Look for a gist described as `catalog-default` (or `catalog-<profile>`)
3. Share the gist ID or URL

### Import someone else's catalog

```bash
/ct init --from-gist=<gist-id>
/ct sync
```

This replaces your entire local catalog with the imported one, including all profiles.

### Limitations

- `/ct init --from-gist` replaces your entire catalog — it does not merge
- There is no command to import a single profile from another user's gist
- You can manually copy profile entries between `cat.yaml` files
