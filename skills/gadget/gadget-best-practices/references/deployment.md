# Deployment

## Environments

Gadget apps have multiple environments:

- **Development** - Your working environment
- **Production** - Live app serving real users

## Deploying to Production

**Via IDE:**
1. Click "Deploy" button in Gadget IDE
2. Review changes
3. Confirm deployment

**Via CLI:**
```bash
ggt deploy --env=production
```

## Deployment Process

1. Code is bundled and optimized
2. Database migrations run automatically
3. Environment variables copied from dev
4. App deployed to production
5. Zero-downtime deployment

## Best Practices

### Before Deploying

✅ Test in development
✅ Run migrations in development first
✅ Check for breaking changes
✅ Review environment variables
✅ Test with production-like data

### After Deploying

✅ Smoke test critical paths
✅ Check logs for errors
✅ Monitor performance
✅ Test key user flows

## Continuous Deployment

Use `ggt deploy` in a CI/CD pipeline to deploy after running tests

## Environment Variables

Set in **Settings → Environment Variables**:

- Development and production have separate values
- Use `GADGET_PUBLIC_*` prefix for frontend variables
- Sync manually or via deploy

## Monitoring

After deployment:
- Check **Logs** tab for errors
- Monitor **Queues** for background jobs
- Check **Ops** for performance

## Best Practices

- ✅ Deploy small, frequent changes
- ✅ Test before deploying
- ✅ Smoke test after deploying
- ✅ Monitor logs and metrics
- ✅ Have a rollback plan
- ❌ Don't deploy untested code
- ❌ Don't skip smoke testing