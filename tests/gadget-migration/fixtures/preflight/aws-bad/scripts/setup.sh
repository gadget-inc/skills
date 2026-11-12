#!/usr/bin/env bash
set -euo pipefail

aws rds create-db-instance --db-instance-identifier my-app-db --engine postgres --engine-version 18.6 \
  --db-instance-class db.m7g.large --allocated-storage 100 --master-username postgres \
  --master-user-password "$DB_PASSWORD" --db-subnet-group-name my-app-private --no-publicly-accessible --multi-az

aws rds create-db-cluster --db-cluster-identifier my-app-staging --engine aurora-postgresql \
  --master-username postgres --master-user-password "$DB_PASSWORD" --storage-encrypted \
  --serverless-v2-scaling-configuration MinCapacity=0,MaxCapacity=16

aws rds create-db-proxy --db-proxy-name my-app --engine-family POSTGRESQL \
  --auth SecretArn=arn:aws:secretsmanager:us-east-1:123456789012:secret:my-app/proxy-postgres-MnOpQr,IAMAuth=DISABLED \
  --role-arn arn:aws:iam::123456789012:role/my-app-proxy --vpc-subnet-ids subnet-0a1b2c3d4e5f60001 subnet-0a1b2c3d4e5f60002

aws sqs create-queue --queue-name jobs-dlq
aws sqs create-queue --queue-name jobs --attributes '{
  "VisibilityTimeout": "900",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"arn:aws:sqs:us-east-1:123456789012:jobs-dlq\",\"maxReceiveCount\":\"7\"}"
}'
aws sqs create-queue --queue-name webhooks --attributes VisibilityTimeout=60

aws scheduler create-schedule --name prune-audit-logs --schedule-expression "cron(0 2 * * 1)" \
  --target '{"Arn": "arn:aws:sqs:us-east-1:123456789012:jobs", "RoleArn": "arn:aws:iam::123456789012:role/my-app-scheduler", "Input": "{\"job\":\"pruneAuditLogs\"}"}'
aws scheduler update-schedule --name prune-audit-logs --state ENABLED

aws ecs create-service --cluster my-app --service-name my-app-web --task-definition my-app-web \
  --desired-count 2 --launch-type FARGATE \
  --load-balancers 'targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-app-web/0123456789abcdef,containerName=app,containerPort=3000'
