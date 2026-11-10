#!/bin/sh
# runs on every instance start
npx prisma db push
exec npm run start
