package main

import (
	"testing"
	"time"
)

func TestEIALookbackCoversFiveDayOverlap(t *testing.T) {
	if eiaLookback < 5*24*time.Hour {
		t.Fatalf("eiaLookback = %s, want at least five days", eiaLookback)
	}
}
