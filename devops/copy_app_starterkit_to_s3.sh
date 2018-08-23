#!/bin/bash

APP_NAME=starterkit
ENVIRONMENT=$(yq r aws/app-${APP_NAME}/manifest-app.yaml "environment.name")
TARGET_BUCKET=${APP_NAME}-app-deploy

aws s3 cp --recursive . s3://${TARGET_BUCKET}/${ENVIRONMENT}/devops
