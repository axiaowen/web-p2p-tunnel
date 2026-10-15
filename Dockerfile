FROM golang:1.23-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 GOOS=linux \
    go build -o /signaling-server \
    ./cmd/signaling-server

FROM alpine:3.20

COPY --from=builder /signaling-server /signaling-server

EXPOSE 8080

CMD ["/signaling-server", "-addr", ":8080"]
