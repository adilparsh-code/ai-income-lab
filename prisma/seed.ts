import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { SqliteClient } from './sqlite-client';

// Mirrors src/lib/db.ts dialect selection: postgres:// → PostgreSQL driver
// adapter (Supabase transaction pooler), file: → the hermetic SQLite test
// client. The URL itself is never printed.
const url = process.env.DATABASE_URL ?? '';
const prisma =
  url.startsWith('file:')
    ? (new SqliteClient({ adapter: new PrismaLibSql({ url }) }) as unknown as PrismaClient)
    : new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

async function main() {
  console.log('Seeding database with sample opportunities...');
  
  // Delete existing data
  await prisma.agentLog.deleteMany();
  await prisma.content.deleteMany();
  await prisma.revenue.deleteMany();
  await prisma.experiment.deleteMany();
  await prisma.product.deleteMany();
  await prisma.affiliate.deleteMany();
  await prisma.opportunity.deleteMany();

  // Create opportunities
  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Children's Coloring & Activity Books",
      category: "Children's Books",
      businessModel: "Direct Sales",
      targetAudience: "Parents of children 3-8",
      problemSolved: "Parents need engaging educational activities",
      monetizationMethod: "Amazon KDP / Etsy sales",
      estimatedStartupCost: 88,
      demandScore: 82,
      competitionScore: 64,
      commercialIntentScore: 91,
      automationScore: 95,
      differentiationScore: 73,
      monetizationScore: 84,
      halalConfidenceScore: 100,
      overallScore: 83,
      status: "VALIDATED",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "Based on Amazon BSR trends and Etsy search volume. SAMPLE DATA - not verified market research.",
      risks: "Market saturation in generic designs. Need unique, high-quality illustrations.",
      nextAction: "Create a sample 20-page coloring book targeting ages 4-6"
    }
  });

  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Printable Teacher Worksheets",
      category: "Teacher Resources",
      businessModel: "Direct Sales",
      targetAudience: "K-5 teachers and homeschool parents",
      problemSolved: "Teachers need ready-to-use curriculum-aligned worksheets",
      monetizationMethod: "Teachers Pay Teachers / Etsy",
      estimatedStartupCost: 92,
      demandScore: 78,
      competitionScore: 58,
      commercialIntentScore: 82,
      automationScore: 85,
      differentiationScore: 65,
      monetizationScore: 79,
      halalConfidenceScore: 100,
      overallScore: 78,
      status: "RESEARCHING",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "TPT marketplace shows strong demand. SAMPLE DATA.",
      risks: "Requires curriculum alignment knowledge. Quality expectations are high.",
      nextAction: "Research top-selling worksheet categories on TPT"
    }
  });

  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Kids Drawing Practice Books",
      category: "Children's Books",
      businessModel: "Direct Sales",
      targetAudience: "Children 4-10 and their parents",
      problemSolved: "Structured drawing practice for young learners",
      monetizationMethod: "Amazon KDP",
      estimatedStartupCost: 90,
      demandScore: 75,
      competitionScore: 70,
      commercialIntentScore: 78,
      automationScore: 88,
      differentiationScore: 80,
      monetizationScore: 76,
      halalConfidenceScore: 100,
      overallScore: 80,
      status: "IDEA",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "Growing niche on KDP. SAMPLE DATA.",
      risks: "Requires quality step-by-step illustrations.",
      nextAction: "Analyze top 10 KDP drawing books for children"
    }
  });

  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Educational Workbooks (Math/English)",
      category: "Educational Content",
      businessModel: "Direct Sales",
      targetAudience: "Parents of children 5-12",
      problemSolved: "Supplementary learning materials for home education",
      monetizationMethod: "Amazon KDP / Website",
      estimatedStartupCost: 85,
      demandScore: 80,
      competitionScore: 52,
      commercialIntentScore: 75,
      automationScore: 72,
      differentiationScore: 60,
      monetizationScore: 78,
      halalConfidenceScore: 100,
      overallScore: 73,
      status: "IDEA",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "Homeschool market growing. SAMPLE DATA.",
      risks: "Requires accurate educational content. Curriculum varies by region.",
      nextAction: "Identify most searched workbook topics by grade level"
    }
  });

  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Niche Educational Affiliate Website",
      category: "Affiliate",
      businessModel: "Affiliate Commission",
      targetAudience: "Parents researching educational tools",
      problemSolved: "Parents struggle to find quality educational resources",
      monetizationMethod: "Amazon Associates / other affiliate programs",
      estimatedStartupCost: 78,
      demandScore: 72,
      competitionScore: 45,
      commercialIntentScore: 80,
      automationScore: 65,
      differentiationScore: 55,
      monetizationScore: 70,
      halalConfidenceScore: 95,
      overallScore: 69,
      status: "IDEA",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "Affiliate marketing remains viable for niche content. SAMPLE DATA.",
      risks: "SEO competition. Requires sustained content creation. Commission rates may change.",
      nextAction: "Identify 5 underserved educational product niches"
    }
  });

  await prisma.opportunity.create({
    data: {
      title: "[SAMPLE] Simple Teacher Utility Tool",
      category: "SaaS/Tool",
      businessModel: "Freemium",
      targetAudience: "Teachers and educators",
      problemSolved: "Teachers need simple tools for grading, scheduling, or resource management",
      monetizationMethod: "Freemium subscription",
      estimatedStartupCost: 50,
      demandScore: 68,
      competitionScore: 40,
      commercialIntentScore: 65,
      automationScore: 55,
      differentiationScore: 70,
      monetizationScore: 60,
      halalConfidenceScore: 100,
      overallScore: 61,
      status: "IDEA",
      halalStatus: "HALAL",
      confidenceLevel: "SAMPLE_DATA",
      evidenceNotes: "Niche SaaS tools for teachers are underserved. SAMPLE DATA.",
      risks: "Requires development skills. Needs clear value proposition over existing tools.",
      nextAction: "Survey teachers about their biggest tool pain points"
    }
  });

  console.log('Seed complete!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
