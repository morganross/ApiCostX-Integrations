# Preset Configuration Guide

Presets are saved run configurations. A preset can select engines, models, source documents, instruction files, run controls, search settings, and engine-specific options.

When the assistant changes a preset, it must read the current canonical preset first, create a preset snapshot, save through ACM's preset API, and record an audit event.
