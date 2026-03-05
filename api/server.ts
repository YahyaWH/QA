import express from 'express';
import mongoose from 'mongoose';
import runsRouter from './routes/runs';
import resultsRouter from './routes/results';
import investigationsRouter from './routes/investigations';
import slackWebhooksRouter from './routes/slack-webhooks';

const app = express();
const PORT = process.env.PORT || 3001;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/wastehero-qa';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
});

// Routes
app.use('/api/v1/runs', runsRouter);
app.use('/api/v1', resultsRouter);
app.use('/api/v1/investigations', investigationsRouter);
app.use('/api/v1/slack', slackWebhooksRouter);

async function start(): Promise<void> {
  console.log(`Connecting to MongoDB: ${MONGO_URI}`);
  await mongoose.connect(MONGO_URI);
  console.log('MongoDB connected');

  app.listen(PORT, () => {
    console.log(`QA API running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start API:', err);
  process.exit(1);
});

export default app;
