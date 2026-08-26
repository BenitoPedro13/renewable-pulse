// Package publish wraps a Redpanda producer with a bounded number of
// in-flight requests, so the poller blocks (backpressure) rather than
// buffering unboundedly in memory when the broker is behind
// (docs/architecture.md §4).
package publish

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/twmb/franz-go/pkg/kgo"

	"github.com/BenitoPedro13/renewable-pulse/apps/ingest/internal/event"
)

type Publisher struct {
	client *kgo.Client
	topic  string
	sem    chan struct{}

	mu       sync.Mutex
	firstErr error
}

// New creates a publisher bounded to maxInFlight concurrent produce
// requests — the "channel/queue depth limit" backpressure mechanism
// docs/architecture.md §4 describes.
func New(brokers []string, topic string, maxInFlight int) (*Publisher, error) {
	client, err := kgo.NewClient(kgo.SeedBrokers(brokers...))
	if err != nil {
		return nil, fmt.Errorf("publish: creating client: %w", err)
	}
	return &Publisher{
		client: client,
		topic:  topic,
		sem:    make(chan struct{}, maxInFlight),
	}, nil
}

// Publish enqueues one reading. It blocks once maxInFlight requests are
// outstanding — the backpressure mechanism — and returns the first produce
// error seen so far, if any.
func (p *Publisher) Publish(ctx context.Context, r event.Reading) error {
	value, err := json.Marshal(r)
	if err != nil {
		return fmt.Errorf("publish: marshaling reading: %w", err)
	}

	select {
	case p.sem <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	p.client.Produce(ctx, &kgo.Record{Topic: p.topic, Value: value}, func(_ *kgo.Record, err error) {
		<-p.sem
		if err != nil {
			p.mu.Lock()
			if p.firstErr == nil {
				p.firstErr = fmt.Errorf("publish: producing: %w", err)
			}
			p.mu.Unlock()
		}
	})

	return p.FirstErr()
}

// FirstErr returns the first produce error observed so far, if any.
func (p *Publisher) FirstErr() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.firstErr
}

// Close flushes any outstanding produce requests and closes the client.
func (p *Publisher) Close(ctx context.Context) error {
	if err := p.client.Flush(ctx); err != nil {
		return fmt.Errorf("publish: flushing: %w", err)
	}
	p.client.Close()
	return p.FirstErr()
}
