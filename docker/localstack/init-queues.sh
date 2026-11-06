#!/bin/bash
# Executado pelo LocalStack quando fica pronto (/etc/localstack/init/ready.d).
set -euo pipefail

REGION=us-east-1
DLQ=wager-transactions-dlq.fifo
MAIN=wager-transactions.fifo
EVENTS=wagering-events

awslocal sqs create-queue --region "$REGION" --queue-name "$DLQ" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false

DLQ_URL=$(awslocal sqs get-queue-url --region "$REGION" --queue-name "$DLQ" --query QueueUrl --output text)
DLQ_ARN=$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" \
  --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)

# Redrive: após 5 recebimentos sem ack, a mensagem vai para a DLQ.
awslocal sqs create-queue --region "$REGION" --queue-name "$MAIN" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"false\",\"VisibilityTimeout\":\"30\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$DLQ_ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Destino dos eventos de integração (decisão nossa; o desafio não define).
awslocal sqs create-queue --region "$REGION" --queue-name "$EVENTS"

echo "queues ready"
