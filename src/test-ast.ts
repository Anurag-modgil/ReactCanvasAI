import { transformJSX } from './compiler-plugin';
import { updateElementClasses, updateElementText, updateElementStyles, generateLineDiff } from './ast-engine';

// Mock JSX code
const initialJSX = `import React from 'react';

export default function Hero() {
  return (
    <div className="bg-slate-900 text-white min-h-screen flex flex-col justify-center items-center">
      <h1 className="text-4xl font-extrabold tracking-tight">
        ReactCanvas AI
      </h1>
      <p className="mt-4 text-slate-400 max-w-md text-center">
        Visual editing for modern developers.
      </p>
      <button className="mt-8 px-6 py-3 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg shadow-lg">
        Get Started
      </button>
    </div>
  );
}
`;

function runTests() {
  console.log('--- STARTING AST ENGINE & COMPILER PLUGIN TESTS ---');

  // Test 1: Compiler JSX Instrumentation
  console.log('\n[Test 1] Testing JSX compiler instrumentation...');
  const instrumented = transformJSX(initialJSX, 'src/components/Hero.tsx');
  
  // Verify data-rc attributes exist
  if (!instrumented.includes('data-rc-file="src/components/Hero.tsx"') ||
      !instrumented.includes('data-rc-line="5"') ||
      !instrumented.includes('data-rc-line="6"')) {
    throw new Error('Test 1 Failed: data-rc attributes not correctly injected.');
  }
  console.log('✓ Test 1 Passed: JSX correctly instrumented.');

  // Test 2: Edit Visual Tailwind Classes
  console.log('\n[Test 2] Testing Tailwind class updates via AST...');
  // The <h1> tag is on line 6 in initialJSX. Let's update its classes.
  const editedClasses = updateElementClasses(initialJSX, 6, 0, 'text-5xl font-black text-indigo-400');
  
  if (!editedClasses.includes('className="text-5xl font-black text-indigo-400"')) {
    throw new Error('Test 2 Failed: h1 className was not updated correctly.');
  }
  // Verify other parts of the code remained identical (formatting test)
  if (!editedClasses.includes('Visual editing for modern developers.')) {
    throw new Error('Test 2 Failed: Formatting of other parts of the file was corrupted.');
  }
  console.log('✓ Test 2 Passed: Tailwind classes successfully modified without corruption.');

  // Test 3: Edit Text Content
  console.log('\n[Test 3] Testing Text content updates via AST...');
  // The <p> tag is on line 9 in initialJSX. Let's update its text.
  const editedText = updateElementText(initialJSX, 9, 0, 'Visual Cursor meets live React code.');
  
  if (!editedText.includes('Visual Cursor meets live React code.')) {
    throw new Error('Test 3 Failed: Paragraph text was not updated.');
  }
  if (editedText.includes('Visual editing for modern developers.')) {
    throw new Error('Test 3 Failed: Original text was not replaced.');
  }
  console.log('✓ Test 3 Passed: Element text content successfully replaced.');

  // Test 4: Inline Style Manipulation
  console.log('\n[Test 4] Testing inline styles manipulation...');
  // Let's add inline styles to the button (line 12)
  const editedStyles = updateElementStyles(initialJSX, 12, 0, { transitionDelay: '100ms', opacity: 0.95 });
  
  if (!editedStyles.includes('style={{') || !editedStyles.includes('transitionDelay: "100ms"') || !editedStyles.includes('opacity: 0.95')) {
    throw new Error('Test 4 Failed: Inline styles were not correctly injected.');
  }
  console.log('✓ Test 4 Passed: Inline style ObjectExpression correctly merged and outputted.');

  // Test 5: Diff Generation
  console.log('\n[Test 5] Testing unified diff generation...');
  const newContent = initialJSX.replace('ReactCanvas AI', 'VisualCursor AI').replace('Get Started', 'Launch Pilot');
  const diffResult = generateLineDiff(initialJSX, newContent);
  
  if (!diffResult.includes('-') || !diffResult.includes('+') ||
      !diffResult.includes('ReactCanvas AI') || !diffResult.includes('VisualCursor AI')) {
    throw new Error('Test 5 Failed: Unified diff is incorrect.');
  }
  console.log('✓ Test 5 Passed: Line-by-line diff correctly compiled.');

  console.log('\n--- ALL AUTOMATED VALIDATION TESTS PASSED SUCCESSFULLY! ---');
}

try {
  runTests();
} catch (error) {
  console.error('\n❌ TEST SUITE FAILED:', error);
  process.exit(1);
}
