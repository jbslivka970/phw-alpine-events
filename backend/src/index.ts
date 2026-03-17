import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import importRouter from './routes/import';

dotenv.config();

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.get('/', (_req, res) => {
  res.json({ message: 'PHW Alpine Events API' });
});

app.use('/api/v1/import', importRouter);

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;