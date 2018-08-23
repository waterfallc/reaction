#!/bin/bash

TARGET_BUCKET=reaction-staging-ecs-deploy

aws s3 cp --recursive . s3://${TARGET_BUCKET}/devops
