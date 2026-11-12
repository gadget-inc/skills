#!/usr/bin/env bash
set -euo pipefail
NETWORK='awsvpcConfiguration={subnets=[subnet-0a1b2c3d4e5f60001,subnet-0a1b2c3d4e5f60002],securityGroups=[sg-0a1b2c3d4e5f60003]}'

TASK=$(aws ecs run-task --cluster my-app --task-definition my-app-migrate --launch-type FARGATE \
  --network-configuration "$NETWORK" --query 'tasks[0].taskArn' --output text)
aws ecs wait tasks-stopped --cluster my-app --tasks "$TASK"

aws ecs update-service --cluster my-app --service my-app-worker --task-definition my-app-worker > /dev/null
aws ecs update-service --cluster my-app --service my-app-web --task-definition my-app-web > /dev/null
